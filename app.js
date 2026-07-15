const CART_SESSION_KEY = 'amazon-cart-session-id';
const API_BASE = getApiBaseUrl();
const PRODUCTS_PER_PAGE = 12;

function getApiBaseUrl() {
    const urlParams = new URLSearchParams(window.location.search);
    const apiParam = urlParams.get('api');
    if (apiParam) return apiParam.replace(/\/$/, '');
    const meta = document.querySelector('meta[name="api-base-url"]');
    if (meta && meta.content) return meta.content.replace(/\/$/, '');
    if (window.location.protocol.startsWith('http')) return window.location.origin;
    return '';
}

let products = [];
let cart = [];
let recentlyViewed = JSON.parse(localStorage.getItem('recentlyViewed')) || [];
let currentSlide = 0;
let filteredProducts = [];
let modalQuantity = 1;
let dealTimerId = null;
let checkoutContext = null;
let wishlist = [];
let comparisonList = [];
const MAX_COMPARE = 4;
let currentPage = 1;
let isLoadingPage = false;

function isElement(el) { return el instanceof Element; }

function getById(id) { return document.getElementById(id); }

function onReady(callback) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', callback);
    else callback();
}

onReady(() => {
    renderShareableLink();
    initializeApp().catch((error) => {
        console.error('Failed to initialize application', error);
        showToast('Unable to load shop data');
    });
    initEventDelegation();
});

function renderShareableLink() {
    const bannerText = getById('share-link-text');
    if (!bannerText) return;
    let shareUrl = window.location.href;
    if (window.location.protocol === 'file:' || window.location.origin === 'null') {
        shareUrl = `${window.location.protocol}//${window.location.hostname}${window.location.port ? `:${window.location.port}` : ''}${window.location.pathname}`;
    }
    bannerText.textContent = shareUrl;
    bannerText.title = 'Click to copy';
    bannerText.style.cursor = 'pointer';
    bannerText.onclick = () => navigator.clipboard.writeText(shareUrl).then(() => showToast('URL copied to clipboard!')).catch(() => showToast('Copy: ' + shareUrl));
}

async function initializeApp() {
    const yearEl = getById('footer-year');
    if (yearEl) yearEl.textContent = new Date().getFullYear();

    showSkeleton('products-grid', 'grid');
    showSkeleton('deal-container', 'deal');
    showSkeleton('recently-viewed', 'list');

    try {
        products = await fetchProducts();
        filteredProducts = [...products];
        hideSkeleton('products-grid');
    } catch (error) {
        console.error('Failed to load products', error);
        hideSkeleton('products-grid');
        const grid = getById('products-grid');
        if (grid) grid.innerHTML = '<div class="error-state"><i class="fas fa-exclamation-triangle"></i><h3>Could not load products</h3><p>Make sure the server is running.</p></div>';
        throw error;
    }

    try { cart = await fetchCart(); } catch { cart = []; }
    try { wishlist = await fetchWishlist(); } catch { wishlist = []; }

    const savedCart = localStorage.getItem('cart');
    if (savedCart) {
        try {
        const parsed = JSON.parse(savedCart);
        if (parsed.length > 0 && cart.length === 0) {
            cart = parsed.map(item => {
            const product = products.find(p => p.id === item.id);
            return product ? { ...product, quantity: item.quantity || 1 } : item;
            });
            saveCart();
            updateCartUI();
            setTimeout(() => showToast('Items restored from your previous session'), 1500);
        }
        } catch {}
    }

    renderProducts(getPageItems());
    renderPagination();
    hideSkeleton('deal-container');
    renderDealOfTheDay();
    renderRecentlyViewed();
    hideSkeleton('recently-viewed');
    updateCartUI();
    initSlider();
    initSliderDots();
    initStaticEventListeners();
    initDarkMode();
    initVoiceSearch();
    checkAuth();

    // PWA registration
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(() => {});
    }

    // Gift card model
    const navGiftCards = getById('nav-giftcards');
    if (navGiftCards) navGiftCards.addEventListener('click', () => {
        const overlay = getById('giftcard-modal-overlay');
        if (overlay) overlay.style.display = 'flex';
    });

    // Dismiss abandoned cart banner
    const dismissBanner = getById('dismiss-cart-banner');
    if (dismissBanner) dismissBanner.addEventListener('click', () => {
        const banner = getById('abandoned-cart-banner');
        if (banner) banner.style.display = 'none';
    });

    // Cart restore link
    const restoreLink = getById('cart-restore-link');
    if (restoreLink) restoreLink.addEventListener('click', openCart);

    // Gift card amount buttons
    document.querySelectorAll('.giftcard-amount-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.giftcard-amount-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const input = getById('giftcard-custom-amount');
            if (input) input.value = btn.dataset.amount;
        });
    });

    // Gift card purchase
    const purchaseBtn = getById('purchase-giftcard-btn');
    if (purchaseBtn) purchaseBtn.addEventListener('click', purchaseGiftCard);

    // Gift card close
    const giftCardCloseBtn = getById('giftcard-close-btn');
    if (giftCardCloseBtn) giftCardCloseBtn.addEventListener('click', () => {
        const overlay = getById('giftcard-modal-overlay');
        if (overlay) overlay.style.display = 'none';
    });

    // Close gift card on overlay click
    const giftCardOverlay = getById('giftcard-modal-overlay');
    if (giftCardOverlay) giftCardOverlay.addEventListener('click', (e) => {
        if (e.target === giftCardOverlay) giftCardOverlay.style.display = 'none';
    });
}

function showSkeleton(containerId, type) {
    const el = getById(containerId);
    if (!el) return;
    if (type === 'grid') {
        el.innerHTML = Array(8).fill(0).map(() => `
            <div class="product-card skeleton-card">
                <div class="skeleton skeleton-img"></div>
                <div class="skeleton skeleton-text-short"></div>
                <div class="skeleton skeleton-text"></div>
                <div class="skeleton skeleton-price"></div>
            </div>
        `).join('');
    } else if (type === 'deal') {
        el.innerHTML = '<div class="skeleton skeleton-deal"></div>';
    } else {
        el.innerHTML = '<div class="skeleton skeleton-recent"></div>';
    }
}

function hideSkeleton(containerId) { /* content replaces skeletons */ }

function showLoading(btn) {
    if (!btn) return;
    btn.disabled = true;
    btn._origHtml = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading...';
}
function hideLoading(btn) {
    if (!btn) return;
    btn.disabled = false;
    if (btn._origHtml) btn.innerHTML = btn._origHtml;
}

function getPageItems() {
    const start = 0;
    const end = currentPage * PRODUCTS_PER_PAGE;
    return filteredProducts.slice(start, end);
}

function getTotalPages() {
    return Math.ceil(filteredProducts.length / PRODUCTS_PER_PAGE);
}

function renderPagination() {
    const total = getTotalPages();
    if (total <= 1) return;
    const grid = getById('products-grid');
    if (!grid) return;
    const existing = grid.parentElement.querySelector('.pagination');
    if (existing) existing.remove();
    const nav = document.createElement('div');
    nav.className = 'pagination';
    nav.innerHTML = `
        <button class="page-btn" data-page="prev" ${currentPage <= 1 ? 'disabled' : ''}>&laquo; Prev</button>
        <span class="page-info">Page ${currentPage} of ${total}</span>
        <button class="page-btn" data-page="next" ${currentPage >= total ? 'disabled' : ''}>Next &raquo;</button>
    `;
    grid.parentElement.appendChild(nav);
}

async function fetchProducts() {
    const response = await fetch(`${API_BASE}/api/products?per_page=100`);
    if (!response.ok) throw new Error(`Failed to load products: ${response.status}`);
    const data = await response.json();
    return data.products || data;
}

function getSessionId() {
    let sessionId = localStorage.getItem(CART_SESSION_KEY);
    if (!sessionId) {
        sessionId = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : `session-${Date.now()}`;
        localStorage.setItem(CART_SESSION_KEY, sessionId);
    }
    return sessionId;
}

function normalizeProductSnapshot(item) {
    const { quantity, product, ...snapshot } = item;
    return snapshot;
}

function normalizeCartItem(item) {
    const product = item.product || products.find(p => p.id === item.id);
    if (!product) return { id: item.id, quantity: item.quantity || 1, title: 'Unknown item', image: '', price: 0 };
    return { ...product, quantity: item.quantity || 1 };
}

async function fetchCart() {
    try {
        const response = await fetch(`${API_BASE}/api/cart/${getSessionId()}`);
        if (!response.ok) return [];
        const items = await response.json();
        return items.map(normalizeCartItem);
    } catch { return []; }
}

async function syncCart() {
    try {
        await fetch(`${API_BASE}/api/cart/${getSessionId()}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(cart.map(item => ({ id: item.id, quantity: item.quantity, product: normalizeProductSnapshot(item) })))
        });
    } catch { console.warn('Cart sync failed'); }
}

function saveCart() {
    localStorage.setItem('cart', JSON.stringify(cart));
    syncCart();
}

async function fetchWishlist() {
    try {
        const response = await fetch(`${API_BASE}/api/wishlist/${getSessionId()}`);
        if (!response.ok) return [];
        return await response.json();
    } catch { return []; }
}

async function addToWishlist(productId) {
    try {
        await fetch(`${API_BASE}/api/wishlist/${getSessionId()}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ productId })
        });
        wishlist = await fetchWishlist();
        updateWishlistUI();
        showToast('Added to wishlist');
    } catch { showToast('Failed to add to wishlist'); }
}

async function removeFromWishlist(productId) {
    try {
        await fetch(`${API_BASE}/api/wishlist/${getSessionId()}/${productId}`, { method: 'DELETE' });
        wishlist = await fetchWishlist();
        updateWishlistUI();
        showToast('Removed from wishlist');
    } catch { showToast('Failed to remove from wishlist'); }
}

async function toggleWishlist(productId) {
    if (wishlist.some(p => p.id === productId)) await removeFromWishlist(productId);
    else await addToWishlist(productId);
}

function isWishlisted(productId) { return wishlist.some(p => p.id === productId); }

function updateWishlistUI() {
    document.querySelectorAll('.wishlist-btn').forEach(btn => {
        const pid = parseInt(btn.dataset.id);
        btn.classList.toggle('active', isWishlisted(pid));
    });
}

function toggleCompare(id) {
    const idx = comparisonList.indexOf(id);
    if (idx > -1) { comparisonList.splice(idx, 1); }
    else if (comparisonList.length >= MAX_COMPARE) { showToast(`Max ${MAX_COMPARE} items to compare`); return; }
    else { comparisonList.push(id); }
    updateCompareUI();
}

function updateCompareUI() {
    const countEl = getById('compare-count');
    if (countEl) countEl.textContent = comparisonList.length;
    document.querySelectorAll('.compare-btn').forEach(btn => {
        const pid = parseInt(btn.dataset.id);
        btn.classList.toggle('active', comparisonList.includes(pid));
    });
    const panel = getById('compare-panel');
    if (!panel) return;
    if (comparisonList.length < 2) { panel.style.display = 'none'; return; }
    panel.style.display = 'block';
    const items = comparisonList.map(id => products.find(p => p.id === id)).filter(Boolean);
    const body = getById('compare-body');
    if (!body) return;
    body.innerHTML = `
    <table class="compare-table">
        <tr><th>Product</th>${items.map(p => `<td><img loading="lazy" src="${p.image}" width="80"><br>${p.title}</td>`).join('')}</tr>
        <tr><th>Price</th>${items.map(p => `<td>$${p.price.toFixed(2)}</td>`).join('')}</tr>
        <tr><th>Rating</th>${items.map(p => `<td>${'★'.repeat(Math.round(p.rating))}${'☆'.repeat(5-Math.round(p.rating))} (${p.rating})</td>`).join('')}</tr>
        <tr><th>Category</th>${items.map(p => `<td>${p.category}</td>`).join('')}</tr>
        <tr><th>Stock</th>${items.map(p => `<td>${p.stock > 0 ? 'In Stock' : 'Out of Stock'}</td>`).join('')}</tr>
        <tr><th>Features</th>${items.map(p => `<td><ul>${(p.features||[]).map(f => `<li>${f}</li>`).join('')}</ul></td>`).join('')}</tr>
    </table>
    <button class="compare-close-btn" onclick="document.getElementById('compare-panel').style.display='none'">Close</button>`;
}

function clearCompare() {
    comparisonList = [];
    updateCompareUI();
}

function toggleWishlistPage() {
    const page = getById('wishlist-page');
    const overlay = getById('wishlist-page-overlay');
    if (!page || !overlay) return;
    const isOpen = page.classList.contains('open');
    if (isOpen) {
        page.classList.remove('open');
        overlay.classList.remove('show');
        document.body.style.overflow = '';
    } else {
        page.classList.add('open');
        overlay.classList.add('show');
        document.body.style.overflow = 'hidden';
        renderWishlistPage();
    }
}

function renderWishlistPage() {
    const container = getById('wishlist-page-content');
    if (!container) return;
    if (wishlist.length === 0) {
        container.innerHTML = '<div class="wishlist-empty"><i class="fas fa-heart-broken"></i><p>Your wishlist is empty</p></div>';
        return;
    }
    container.innerHTML = wishlist.map(p => `
        <div class="wishlist-item">
            <img loading="lazy" src="${p.image}" alt="${p.title}" data-action="quickview" data-id="${p.id}">
            <div class="wishlist-item-info" data-action="quickview" data-id="${p.id}">
                <h4>${p.title}</h4>
                <span class="wishlist-item-price">$${p.price.toFixed(2)}</span>  
            </div>
            <div class="wishlist-item-actions">
                <button class="add-to-cart-btn" data-action="addcart" data-id="${p.id}">Add to Cart</button>
                <button class="remove-wishlist-btn" data-action="removewl" data-id="${p.id}"><i class="fas fa-trash"></i></button>
            </div>
        </div>
    `).join('');
}

async function loadReviews(productId) {
    try {
        const response = await fetch(`${API_BASE}/api/reviews/${productId}`);
        if (!response.ok) return [];
        return await response.json();
    } catch { return []; }
}

async function submitReview(productId, rating, comment) {
    try {
        const response = await fetch(`${API_BASE}/api/reviews`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ productId, sessionId: getSessionId(), rating, comment })
        });
        if (!response.ok) throw new Error('Failed');
        showToast('Review submitted');
        const reviews = await loadReviews(productId);
        renderReviews(reviews);
    } catch { showToast('Failed to submit review'); }
}

function renderReviews(reviews) {
    const container = getById('modal-reviews');
    if (!container) return;
    if (reviews.length === 0) {
        container.innerHTML = '<p class="empty-message">No reviews yet. Be the first to review!</p>';
        return;
    }
    container.innerHTML = reviews.map(r => `
        <div class="review-item">
            <div class="review-stars">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</div>
            <p class="review-comment">${r.comment || 'No comment'}</p>
            <span class="review-date">${r.createdAt || ''}</span>
        </div>
    `).join('');
}

async function handleQuestionAsk(btn) {
  const productId = parseInt(btn.dataset.id);
  const input = getById(`qa-input-${productId}`);
  const question = input?.value.trim();
  if (!question) return;
  try {
    await fetch(`${API_BASE}/api/products/${productId}/qa`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, sessionId: getSessionId(), authorName: 'Guest' })
    });
    input.value = '';
    loadQA(productId);
  } catch { showToast('Failed to submit question'); }
}

async function loadQA(productId) {
  const list = getById('qa-list');
  if (!list) return;
  try {
    const r = await fetch(`${API_BASE}/api/products/${productId}/qa`);
    const qas = await r.json();
    if (qas.length === 0) { list.innerHTML = '<p class="empty-message">No questions yet. Ask one above!</p>'; return; }
    list.innerHTML = qas.map(q => `
      <div class="qa-item">
        <div class="qa-question"><strong>Q:</strong> ${q.question} <span class="qa-author">- ${q.authorName}</span></div>
        ${q.answer ? `<div class="qa-answer"><strong>A:</strong> ${q.answer}</div>` : `<div class="qa-answer pending"><em>Awaiting answer</em></div>`}
      </div>
    `).join('');
  } catch { list.innerHTML = '<p class="empty-message">Failed to load questions</p>'; }
}

// ---------------------------------------------------------------------------
// Product Zoom
// ---------------------------------------------------------------------------

function initProductZoom() {
    const wrapper = getById('modal-image-wrapper');
    const image = getById('modal-image');
    const lens = getById('zoom-lens');
    const result = getById('zoom-result');
    if (!wrapper || !image || !lens || !result) return;
    result.style.backgroundImage = `url('${image.src}')`;
    wrapper.addEventListener('mousemove', (e) => {
        const rect = wrapper.getBoundingClientRect();
        let x = e.clientX - rect.left - lens.offsetWidth / 2;
        let y = e.clientY - rect.top - lens.offsetHeight / 2;
        x = Math.max(0, Math.min(x, rect.width - lens.offsetWidth));
        y = Math.max(0, Math.min(y, rect.height - lens.offsetHeight));
        lens.style.left = x + 'px';
        lens.style.top = y + 'px';
        lens.style.display = 'block';
        result.style.display = 'block';
        const cx = result.offsetWidth / lens.offsetWidth;
        const cy = result.offsetHeight / lens.offsetHeight;
        result.style.backgroundSize = `${image.offsetWidth * cx}px ${image.offsetHeight * cy}px`;
        result.style.backgroundPosition = `-${x * cx}px -${y * cy}px`;
    });
    wrapper.addEventListener('mouseleave', () => {
        lens.style.display = 'none';
        result.style.display = 'none';
    });
}

// ---------------------------------------------------------------------------
// Price History Chart
// ---------------------------------------------------------------------------

function renderPriceChart(productId, data) {
    const canvas = getById('price-ch art');
    const emptyMsg = getById('price-history-empty');
    if (!canvas || !emptyMsg) return;
    const history = data.history || [];
    if (history.length < 2 && !data.currentPrice) {
        emptyMsg.style.display = 'block';
        canvas.style.display = 'none';
        return;
    }
    emptyMsg.style.display = 'none';
    canvas.style.display = 'block';
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const pad = { top: 10, bottom: 20, left: 5, right: 5 };
    const chartW = w - pad.left - pad.right;
    const chartH = h - pad.top - pad.bottom;
    const points = [...history.map(p => p.price), data.currentPrice];
    const min = Math.min(...points) * 0.95;
    const max = Math.max(...points) * 1.05;
    const range = max - min || 1;
    const toY = (v) => pad.top + chartH - ((v - min) / range) * chartH;
    const toX = (i) => pad.left + (i / (points.length - 1 || 1)) * chartW;
    ctx.beginPath();
    ctx.strokeStyle = '#f08804';
    ctx.lineWidth = 2;
    points.forEach((p, i) => { const x = toX(i), y = toY(p); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
    ctx.stroke();
    points.forEach((p, i) => {
        ctx.beginPath();
        ctx.arc(toX(i), toY(p), 3, 0, Math.PI * 2);
        ctx.fillStyle = '#b12704';
        ctx.fill();
    });
    ctx.fillStyle = '#666';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    if (history.length > 0) {
        ctx.fillText('$' + history[0].price.toFixed(2), toX(0), h - 2);
        ctx.fillText('$' + data.currentPrice.toFixed(2), toX(points.length - 1), h - 2);
    }
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

async function fetchOrders() {
    try {
        const response = await fetch(`${API_BASE}/api/orders?session_id=${getSessionId()}`);
        if (!response.ok) return [];
        return await response.json();
    } catch { return []; }
}

async function downloadInvoice(orderId) {
    try {
    const r = await fetch(`${API_BASE}/api/orders/${orderId}/invoice`);
    if (!r.ok) { showToast('Failed to generate invoice'); return; }
    const html = await r.text();
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `invoice-${orderId}.html`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Invoice downloaded');
    } catch { showToast('Failed to download invoice'); }
}

window.downloadInvoice = downloadInvoice;

async function toggleOrdersPage() {
    const overlay = getById('orders-overlay');
    if (!overlay) return;
    const isOpen = overlay.classList.contains('open');
    if (isOpen) {
        overlay.classList.remove('open');
        document.body.style.overflow = '';
    } else {
        overlay.classList.add('open');
        document.body.style.overflow = 'hidden';
        const content = getById('orders-page-content');
        if (content) content.innerHTML = '<p class="empty-message">Loading your orders...</p>';
        const orders = await fetchOrders();
        const pageContent = getById('orders-page-content');
        if (!pageContent) return;
        if (orders.length === 0) {
            pageContent.innerHTML = `<div class="orders-empty"><i class="fas fa-box-open"></i><h3>No orders yet</h3><p>You haven't placed any orders yet.</p></div>`;
            return;
        }
        pageContent.innerHTML = orders.map(o => `
            <div class="order-card">
                <div class="order-card-header">
                    <span class="order-id">${o.orderId}</span>
                    <span class="order-date">${new Date(o.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}</span>
                    <span class="order-status ${o.status}">${o.status}</span>
                </div>
                <div class="order-items" id="order-items-${o.orderId}">
                    <p class="empty-message">Loading items...</p>
                </div>
                ${o.trackingUpdates && o.trackingUpdates.length ? `
<div class="order-tracking">
    <h4><i class="fas fa-truck"></i> Tracking: ${o.trackingCode}</h4>
    <div class="tracking-timeline">
        ${o.trackingUpdates.map((u, i) => `
        <div class="tracking-step ${i === 0 ? 'active' : ''}">
            <div class="tracking-dot"></div>
            <div class="tracking-info">
                <strong>${u.status}</strong>
                <span>${u.date}</span>
                <p>${u.message}</p>
            </div>
        </div>`).join('')}
    </div>
</div>` : ''}
                <div class="order-total-row">
                    <span>Total (${o.itemCount} item${o.itemCount === 1 ? '' : 's'})</span>
                    <span>$${o.total.toFixed(2)}</span>
                    <button class="invoice-btn" onclick="downloadInvoice('${o.orderId}')"><i class="fas fa-file-invoice"></i> Invoice</button>
                </div>
            </div>
        `).join('');
        // Fetch items for each order
        orders.forEach(async (o) => {
            try {
                const r = await fetch(`${API_BASE}/api/orders/${o.orderId}`);
                if (!r.ok) return;
                const data = await r.json();
                const itemsEl = getById(`order-items-${o.orderId}`);
                if (!itemsEl) return;
                if (!data.items || data.items.length === 0) {
                    itemsEl.innerHTML = '<p class="empty-message">No items</p>';
                    return;
                }
                itemsEl.innerHTML = data.items.map(i => `
                    <div class="order-item">
                        <img loading="lazy" src="${i.image}" alt="${i.title}" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2250%22 height=%2250%22><rect fill=%22%23ddd%22 width=%2250%22 height=%2250%22/></svg>'">
                        <div class="order-item-info">
                            <div class="order-item-title">${i.title}</div>
                            <div class="order-item-meta">Qty: ${i.quantity}</div>
                        </div>
                        <div class="order-item-price">$${i.price.toFixed(2)}</div>
                    </div>
                `).join('');
            } catch {}
        });
    }
}

window.toggleOrdersPage = toggleOrdersPage;

function initStaticEventListeners() {
    const cartIcon = getById('cart-icon');
    const closeCartButton = getById('close-cart');
    const cartOverlayEl = getById('cart-overlay');
    const modalCloseButton = getById('modal-close');
    const checkoutModalCloseEl = getById('checkout-modal-close');
    const checkoutFormEl = getById('checkout-form');
    const searchButton = getById('search-btn');
    const checkoutButton = getById('checkout-btn');
    const successModalCloseBtnEl = getById('success-modal-close-btn');
    const backToTopButton = getById('back-to-top');
    const paymentSelect = getById('checkout-payment');

    if (cartIcon) cartIcon.addEventListener('click', openCart);
    if (closeCartButton) closeCartButton.addEventListener('click', closeCart);
    if (cartOverlayEl) cartOverlayEl.addEventListener('click', closeCart);
    if (modalCloseButton) modalCloseButton.addEventListener('click', closeModal);
    if (checkoutModalCloseEl) checkoutModalCloseEl.addEventListener('click', closeCheckoutModal);
    if (checkoutFormEl) checkoutFormEl.addEventListener('submit', submitCheckout);
    if (searchButton) searchButton.addEventListener('click', handleSearch);
    if (checkoutButton) checkoutButton.addEventListener('click', handleCheckout);
    if (successModalCloseBtnEl) successModalCloseBtnEl.addEventListener('click', closeSuccessModal);
    if (backToTopButton) backToTopButton.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    if (paymentSelect) paymentSelect.addEventListener('change', handlePaymentMethodChange);

    const darkModeBtn = getById('dark-mode-toggle');
    if (darkModeBtn) darkModeBtn.addEventListener('click', toggleDarkMode);

    const couponApplyBtn = getById('apply-coupon-btn');
    if (couponApplyBtn) couponApplyBtn.addEventListener('click', applyCoupon);

    const giftCardBtn = getById('apply-giftcard-btn');
    if (giftCardBtn) giftCardBtn.addEventListener('click', applyGiftCard);

    const filterApplyBtn = getById('filter-apply-btn');
    if (filterApplyBtn) filterApplyBtn.addEventListener('click', applyFilters);
    const filterResetBtn = getById('filter-reset-btn');
    if (filterResetBtn) filterResetBtn.addEventListener('click', () => {
        const inputs = document.querySelectorAll('.filter-panel input, .filter-panel select');
        inputs.forEach(i => i.value = '');
        applyFilters();
    });

    const wishlistShareBtn = getById('wishlist-share-btn');
    if (wishlistShareBtn) wishlistShareBtn.addEventListener('click', shareWishlist);

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            closeCart(); closeModal(); closeCheckoutModal(); closeSuccessModal(); closeAuthModal();
            const ordersOver = getById('orders-overlay');
            if (ordersOver && ordersOver.classList.contains('open')) toggleOrdersPage();
        }
    });

    document.querySelectorAll('.shop-now-btn').forEach(btn => {
        btn.addEventListener('click', () => document.querySelector('.products-section')?.scrollIntoView({ behavior: 'smooth' }));
    });

    document.querySelectorAll('.category-card').forEach(card => {
        card.addEventListener('click', () => {
            const catSelect = getById('category-select');
            if (catSelect) catSelect.value = card.dataset.category || 'all';
            handleSearch();
            document.querySelector('.products-section')?.scrollIntoView({ behavior: 'smooth' });
        });
    });
}

function initEventDelegation() {
    document.addEventListener('click', (e) => {
        const target = e.target.closest('[data-action]');
        if (!target) return;
        const action = target.dataset.action;
        const id = parseInt(target.dataset.id);

        switch (action) {
            case 'quickview': openQuickView(id); break;
            case 'addcart': addToCart(id); break;
            case 'wishlist': toggleWishlist(id); break;
            case 'compare': toggleCompare(id); break;
            case 'removewl': removeFromWishlist(id); break;
            case 'removecart': removeFromCart(id); break;
            case 'qty-down': updateQuantity(id, -1); break;
            case 'qty-up': updateQuantity(id, 1); break;
            case 'modal-addcart': addToCartFromModal(id); break;
            case 'modal-buynow': buyNow(id); break;
            case 'review-submit': handleReviewSubmit(target); break;
            case 'close-wishlist': toggleWishlistPage(); break;
            case 'auth-signin': signIn(); break;
            case 'auth-signup': signUp(); break;
            case 'gallery-select': {
                const wrapper = getById('modal-image-wrapper');
                const img = getById('modal-image');
                if (!img || !wrapper) return;
                const newSrc = target.src;
                img.src = newSrc;
                wrapper.querySelectorAll('.gallery-thumb').forEach(t => t.classList.remove('active'));
                target.classList.add('active');
                const lens = getById('zoom-lens');
                const result = getById('zoom-result');
                if (lens) lens.style.display = 'none';
                if (result) { result.style.display = 'none'; result.style.backgroundImage = `url('${newSrc}')`; }
                break;
            }
            case 'variant-change': {
                break;
            }
            case 'qa-ask': handleQuestionAsk(target); break;
        }
    });

    document.addEventListener('change', (e) => {
      if (e.target.classList.contains('variant-select')) {
        const modal = e.target.closest('.modal-details');
        if (!modal) return;
        const selects = modal.querySelectorAll('.variant-select');
        const currentProduct = products.find(p => p.id === parseInt(modal.querySelector('[data-action="modal-addcart"]')?.dataset.id));
        if (!currentProduct || !currentProduct.variants) return;
        const selected = {};
        selects.forEach(s => { selected[s.dataset.prop] = s.value; });
        const match = currentProduct.variants.find(v => Object.keys(selected).every(k => v[k] === selected[k]));
        if (match) {
          const priceEl = modal.querySelector('.modal-current-price');
          if (priceEl && match.price) priceEl.textContent = '$' + match.price.toFixed(2);
          const img = getById('modal-image');
          if (img && match.image) img.src = match.image;
        }
      }
    });

    const quickViewModal = getById('quick-view-modal');
    if (quickViewModal) quickViewModal.addEventListener('click', (e) => { if (e.target === quickViewModal) closeModal(); });

    const checkoutModal = getById('checkout-modal');
    if (checkoutModal) checkoutModal.addEventListener('click', (e) => { if (e.target === checkoutModal) closeCheckoutModal(); });

    const successModal = getById('order-success-modal');
    if (successModal) successModal.addEventListener('click', (e) => { if (e.target === successModal) closeSuccessModal(); });

    const authModal = getById('auth-modal');
    if (authModal) authModal.addEventListener('click', (e) => { if (e.target === authModal) closeAuthModal(); });

    // Auth tab switching
    document.querySelectorAll('.auth-tab[data-tab]').forEach(tab => {
        tab.addEventListener('click', () => switchAuthTab(tab.dataset.tab));
    });

    const toggleSignup = getById('auth-toggle-signup');
    if (toggleSignup) toggleSignup.addEventListener('click', (e) => { e.preventDefault(); switchAuthTab('signup'); });

    const toggleSignin = getById('auth-toggle-signin');
    if (toggleSignin) toggleSignin.addEventListener('click', (e) => { e.preventDefault(); switchAuthTab('signin'); });

    const authClose = getById('auth-close-btn');
    if (authClose) authClose.addEventListener('click', closeAuthModal);

    // Chat
    const chatBtn = getById('chat-button');
    if (chatBtn) chatBtn.addEventListener('click', toggleChat);
    const chatCloseBtn = getById('chat-close-btn');
    if (chatCloseBtn) chatCloseBtn.addEventListener('click', toggleChat);
    const chatSendBtn = getById('chat-send-btn');
    if (chatSendBtn) chatSendBtn.addEventListener('click', sendChat);
    const chatInput = getById('chat-input');
    if (chatInput) chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

    // Nav account
    const navAccount = getById('nav-account');
    if (navAccount) navAccount.addEventListener('click', openAuthModal);
    const navOrders = getById('nav-orders');
    if (navOrders) navOrders.addEventListener('click', toggleOrdersPage);
    const navSigninLink = getById('nav-signin-link');
    if (navSigninLink) {
        navSigninLink.addEventListener('click', (e) => { e.preventDefault(); openAuthModal(); });
        navSigninLink.addEventListener('touchstart', (e) => { e.preventDefault(); openAuthModal(); });
    }
    const mobileAuthSignin = getById('mobile-auth-signin');
    if (mobileAuthSignin) mobileAuthSignin.addEventListener('click', (e) => { e.preventDefault(); openAuthModal(); });
    const mobileAuthSignup = getById('mobile-auth-signup');
    if (mobileAuthSignup) mobileAuthSignup.addEventListener('click', (e) => { e.preventDefault(); openAuthModal(); switchAuthTab('signup'); });

    // Orders close
    const closeOrdersBtn = getById('close-orders-page-btn');
    if (closeOrdersBtn) closeOrdersBtn.addEventListener('click', toggleOrdersPage);
    const ordersOverlay = getById('orders-overlay');
    if (ordersOverlay) ordersOverlay.addEventListener('click', (e) => { if (e.target === ordersOverlay) toggleOrdersPage(); });

    // Wishlist nav
    const wishlistNavBtn = getById('wishlist-nav-btn');
    if (wishlistNavBtn) wishlistNavBtn.addEventListener('click', toggleWishlistPage);

    // Close wishlist button
    const closeWlBtn = getById('close-wishlist-page-btn');
    if (closeWlBtn) closeWlBtn.addEventListener('click', toggleWishlistPage);

    // Wishlist page overlay
    const wlOverlay = getById('wishlist-page-overlay');
    if (wlOverlay) wlOverlay.addEventListener('click', toggleWishlistPage);

    const profileLink = getById('nav-profile');
    if (profileLink) profileLink.addEventListener('click', openProfile);
    const profileCloseBtn = getById('profile-close-btn');
    if (profileCloseBtn) profileCloseBtn.addEventListener('click', closeProfile);
    const profileSaveBtn = getById('profile-save-btn');
    if (profileSaveBtn) profileSaveBtn.addEventListener('click', saveProfile);
    const profilePasswordBtn = getById('profile-password-btn');
    if (profilePasswordBtn) profilePasswordBtn.addEventListener('click', changePassword);
    const profileOverlay = getById('profile-overlay');
    if (profileOverlay) profileOverlay.addEventListener('click', (e) => { if (e.target === profileOverlay) closeProfile(); });
    const compareClearBtn = getById('compare-clear-btn');
    if (compareClearBtn) compareClearBtn.addEventListener('click', clearCompare);

    // Profile tab switching
    document.querySelectorAll('.profile-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.profile-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            document.querySelectorAll('.profile-tab-content').forEach(c => c.style.display = 'none');
            const target = getById(tab.dataset.tab);
            if (target) target.style.display = 'block';
        });
    });

    // Search input debounce
    const searchInputEl = getById('search-input');
    if (searchInputEl) searchInputEl.addEventListener('input', debounce(handleSearch, 300));

    const categorySelectEl = getById('category-select');
    if (categorySelectEl) categorySelectEl.addEventListener('change', handleSearch);

    const sortSelectEl = getById('sort-select');
    if (sortSelectEl) sortSelectEl.addEventListener('change', handleSort);

    // Pagination delegation
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.page-btn');
        if (!btn) return;
        if (btn.dataset.page === 'prev' && currentPage > 1) { currentPage--; reloadPageView(); }
        else if (btn.dataset.page === 'next' && currentPage < getTotalPages()) { currentPage++; reloadPageView(); }
    });
}

function handleReviewSubmit(target) {
    const modal = target.closest('.modal-details');
    if (!modal) return;
    const ratingEl = modal.querySelector('#review-rating');
    const commentEl = modal.querySelector('#review-comment');
    const productId = parseInt(target.dataset.id);
    if (!ratingEl || !commentEl) return;
    submitReview(productId, parseInt(ratingEl.value), commentEl.value);
    commentEl.value = '';
    if (ratingEl) ratingEl.value = '5';
}

function reloadPageView() {
    renderProducts(getPageItems());
    renderPagination();
    window.scrollTo({ top: document.querySelector('.products-section')?.offsetTop - 100, behavior: 'smooth' });
}

function getProductById(productId) { return products.find(p => p.id === productId); }

function renderProducts(productsToRender) {
    const grid = getById('products-grid');
    if (!grid) return;
    if (productsToRender.length === 0) {
        grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;text-align:center;padding:60px 20px"><i class="fas fa-search" style="font-size:48px;color:#ddd;margin-bottom:16px;display:block"></i><p style="color:#999">No products found</p></div>';
        return;
    }
    grid.innerHTML = productsToRender.map(product => `
        <div class="product-card" data-id="${product.id}">
            ${product.badge ? `<span class="product-badge ${product.badge}">${product.badge === 'deal' ? 'Deal' : 'Best Seller'}</span>` : ''}
            <button class="wishlist-btn ${isWishlisted(product.id) ? 'active' : ''}" data-action="wishlist" data-id="${product.id}"><i class="fas fa-heart"></i></button>
            <button class="compare-btn ${comparisonList.includes(product.id) ? 'active' : ''}" data-action="compare" data-id="${product.id}" title="Compare"><i class="fas fa-balance-scale"></i></button>
            <img loading="lazy" src="${product.image}" alt="${product.title}" class="product-image" data-action="quickview" data-id="${product.id}" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22200%22><rect fill=%22%23f5f5f5%22 width=%22200%22 height=%22200%22/><text fill=%22%23999%22 x=%2250%%22 y=%2250%%22 text-anchor=%22middle%22 dy=%22.3em%22 font-size=%2214%22>No Image</text></svg>'">
            <h3 class="product-title" data-action="quickview" data-id="${product.id}">${product.title}</h3>
            <div class="product-rating">
                <span class="stars">${renderStars(product.rating)}</span>
                <span class="rating-count">${product.ratingCount.toLocaleString()}</span>
            </div>
            <div class="product-price">
                <span class="current-price"><span class="symbol">$</span>${product.price.toFixed(2)}</span>
                ${product.originalPrice ? `<span class="original-price">$${product.originalPrice.toFixed(2)}</span><span class="discount">(${Math.round((1 - product.price / product.originalPrice) * 100)}% off)</span>` : ''}
            </div>
            <p class="delivery-info-product">FREE delivery <span>Tomorrow</span></p>
            <div class="product-actions">
                <button class="add-to-cart-btn" data-action="addcart" data-id="${product.id}">Add to Cart</button>
                <button class="quick-view-btn" data-action="quickview" data-id="${product.id}"><i class="fas fa-eye"></i></button>
            </div>
        </div>
    `).join('');
}

function renderStars(rating) {
    const fullStars = Math.floor(rating);
    const hasHalfStar = rating % 1 >= 0.5;
    let stars = '';
    for (let i = 0; i < fullStars; i++) stars += '<i class="fas fa-star"></i>';
    if (hasHalfStar) stars += '<i class="fas fa-star-half-alt"></i>';
    for (let i = 0; i < 5 - fullStars - (hasHalfStar ? 1 : 0); i++) stars += '<i class="far fa-star"></i>';
    return stars;
}

function startCountdown(endsAt, elementId) {
  const el = getById(elementId);
  if (!el) return;
  function tick() {
    const diff = new Date(endsAt) - new Date();
    if (diff <= 0) { el.textContent = 'Sale ended'; if (dealTimerId) clearInterval(dealTimerId); return; }
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    el.textContent = `${h}h ${m}m ${s}s`;
  }
  tick();
  if (dealTimerId) clearInterval(dealTimerId);
  dealTimerId = setInterval(tick, 1000);
}

function renderDealOfTheDay() {
    const dealProduct = products.find(p => p.badge === 'deal') || products[0];
    const container = getById('deal-container');
    if (!dealProduct || !container) {
        if (container) container.innerHTML = '<p class="empty-message">No deal available</p>';
        return;
    }
    container.innerHTML = `
        <img loading="lazy" src="${dealProduct.image}" alt="${dealProduct.title}" class="deal-image" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22300%22 height=%22300%22><rect fill=%22%23f5f5f5%22 width=%22300%22 height=%22300%22/><text fill=%22%23999%22 x=%2250%%22 y=%2250%%22 text-anchor=%22middle%22 dy=%22.3em%22 font-size=%2218%22>No Image</text></svg>'">
        <div class="deal-details">
            <h3 class="deal-title">${dealProduct.title}</h3>
            <div class="deal-timer">
                <div class="timer-box"><span class="time" id="hours">12</span><span class="label">Hours</span></div>
                <div class="timer-box"><span class="time" id="minutes">45</span><span class="label">Minutes</span></div>
                <div class="timer-box"><span class="time" id="seconds">30</span><span class="label">Seconds</span></div>
            </div>
            <div class="deal-progress">
                <div class="progress-bar"><div class="progress-fill" style="width: 68%"></div></div>
                <p class="progress-text">68% claimed</p>
            </div>
            ${dealProduct.flashSale ? `<div class="flash-sale-timer"><i class="fas fa-bolt"></i> Flash Sale ends in: <span id="deal-countdown"></span></div>` : ''}
            <div class="deal-price">
                <span class="deal-current-price">$${dealProduct.price.toFixed(2)}</span>
                ${dealProduct.originalPrice ? `<span class="deal-original-price">$${dealProduct.originalPrice.toFixed(2)}</span>` : ''}
            </div>
            <button class="deal-btn" data-action="addcart" data-id="${dealProduct.id}">Add to Cart</button>
        </div>
    `;
    if (dealTimerId) clearInterval(dealTimerId);
    startDealTimer();
    if (dealProduct.flashSale) startCountdown(dealProduct.flashSale.endsAt, 'deal-countdown');
}

function startDealTimer() {
    function updateTimer() {
        const now = new Date();
        const midnight = new Date(now);
        midnight.setHours(24, 0, 0, 0);
        const diff = Math.max(0, Math.floor((midnight - now) / 1000));
        const h = Math.floor(diff / 3600);
        const m = Math.floor((diff % 3600) / 60);
        const s = diff % 60;
        const hoursEl = getById('hours');
        const minutesEl = getById('minutes');
        const secondsEl = getById('seconds');
        if (hoursEl && minutesEl && secondsEl) {
            hoursEl.textContent = h.toString().padStart(2, '0');
            minutesEl.textContent = m.toString().padStart(2, '0');
            secondsEl.textContent = s.toString().padStart(2, '0');
        }
    }
    updateTimer();
    dealTimerId = setInterval(updateTimer, 1000);
}

function addToRecentlyViewed(productId) {
    const product = getProductById(productId);
    if (!product) return;
    recentlyViewed = recentlyViewed.filter(item => item.id !== productId);
    recentlyViewed.unshift(product);
    recentlyViewed = recentlyViewed.slice(0, 10);
    localStorage.setItem('recentlyViewed', JSON.stringify(recentlyViewed));
    renderRecentlyViewed();
}

function renderRecentlyViewed() {
    const container = getById('recently-viewed');
    if (!container) return;
    if (recentlyViewed.length === 0) {
        container.innerHTML = '<p class="empty-message">No recently viewed items</p>';
        return;
    }
    container.innerHTML = recentlyViewed.map(product => `
        <div class="recently-viewed-item" data-action="quickview" data-id="${product.id}">
            <img loading="lazy" src="${product.image}" alt="${product.title}" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22150%22 height=%22150%22><rect fill=%22%23f5f5f5%22 width=%22150%22 height=%22150%22/><text fill=%22%23999%22 x=%2250%%22 y=%2250%%22 text-anchor=%22middle%22 dy=%22.3em%22 font-size=%2212%22>No Image</text></svg>'">
            <p class="price">$${product.price.toFixed(2)}</p>
        </div>
    `).join('');
}

async function addToCart(id, quantity = 1) {
    const product = getProductById(id);
    if (!product) return;
    const prevCart = JSON.parse(JSON.stringify(cart));
    const existing = cart.find(item => item.id === id);
    if (existing) {
        existing.quantity = (existing.quantity || 1) + quantity;
    } else {
        cart.push({ ...product, quantity });
    }
    updateCartUI();
    saveCart();
    showToast(`${product.title} added to cart`);
    try {
        const response = await fetch(`${API_BASE}/api/cart/${getSessionId()}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: cart.map(normalizeProductSnapshot) })
        });
        if (!response.ok) throw new Error('Sync failed');
    } catch {
        cart = prevCart;
        updateCartUI();
        saveCart();
        showToast('Failed to sync cart', true);
    }
}

function removeFromCart(productId) {
    cart = cart.filter(item => item.id !== productId);
    saveCart();
    updateCartUI();
}

function updateQuantity(productId, change) {
    const item = cart.find(ci => ci.id === productId);
    if (!item) return;
    item.quantity += change;
    if (item.quantity <= 0) { removeFromCart(productId); return; }
    saveCart();
    updateCartUI();
}

function updateCartUI() {
    if (!isElement(getById('cart-count')) || !isElement(getById('cart-items')) || !isElement(getById('cart-subtotal'))) return;
    const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
    getById('cart-count').textContent = totalItems;
    const cartItemsEl = getById('cart-items');
    if (cart.length === 0) {
        cartItemsEl.innerHTML = '<div class="cart-empty"><i class="fas fa-shopping-cart"></i><p>Your cart is empty</p></div>';
    } else {
        cartItemsEl.innerHTML = cart.map(item => `
            <div class="cart-item">
                <img loading="lazy" src="${item.image}" alt="${item.title}" class="cart-item-image" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2280%22 height=%2280%22><rect fill=%22%23f5f5f5%22 width=%2280%22 height=%2280%22/><text fill=%22%23999%22 x=%2250%%22 y=%2250%%22 text-anchor=%22middle%22 dy=%22.3em%22 font-size=%2210%22>No Image</text></svg>'">
                <div class="cart-item-details">
                    <h4 class="cart-item-title">${item.title}</h4>
                    <p class="cart-item-price">$${item.price.toFixed(2)}</p>
                    <div class="cart-item-quantity">
                        <button class="quantity-btn" data-action="qty-down" data-id="${item.id}">-</button>
                        <span class="quantity-value">${item.quantity}</span>
                        <button class="quantity-btn" data-action="qty-up" data-id="${item.id}">+</button>
                        <button class="remove-item" data-action="removecart" data-id="${item.id}">Delete</button>
                    </div>
                </div>
            </div>
        `).join('');
    }
    const subtotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
    getById('cart-subtotal').textContent = `$${subtotal.toFixed(2)}`;
}

function openCart() {
    const sidebar = getById('cart-sidebar');
    const overlay = getById('cart-overlay');
    if (sidebar && overlay) { sidebar.classList.add('open'); overlay.classList.add('show'); document.body.style.overflow = 'hidden'; }
}

function closeCart() {
    const sidebar = getById('cart-sidebar');
    const overlay = getById('cart-overlay');
    if (sidebar && overlay) { sidebar.classList.remove('open'); overlay.classList.remove('show'); document.body.style.overflow = ''; }
}

function handleCheckout() {
    if (cart.length === 0) { showToast('Your cart is empty!'); return; }
    openCheckoutModal(cart, true);
}

function openQuickView(productId) {
    const product = getProductById(productId);
    if (!product) return;
    addToRecentlyViewed(productId);
    modalQuantity = 1;
    const modalBodyEl = getById('modal-body');
    const quickViewModal = getById('quick-view-modal');
    if (!modalBodyEl || !quickViewModal) return;
    const wlActive = isWishlisted(productId);
    modalBodyEl.innerHTML = `
        <div class="modal-image-col">
            <div class="modal-image-wrapper" id="modal-image-wrapper">
                <img loading="lazy" src="${product.image}" alt="${product.title}" class="modal-image" id="modal-image" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22350%22 height=%22350%22><rect fill=%22%23f5f5f5%22 width=%22350%22 height=%22350%22/><text fill=%22%23999%22 x=%2250%%22 y=%2250%%22 text-anchor=%22middle%22 dy=%22.3em%22 font-size=%2220%22>No Image</text></svg>'">
                <div class="zoom-lens" id="zoom-lens"></div>
            </div>
            <div class="zoom-result" id="zoom-result"></div>
            ${(() => {
  if (product.images && product.images.length > 1) {
    return `<div class="gallery-thumbs">${product.images.map((img, i) => `<img loading="lazy" src="${img}" class="gallery-thumb ${i===0?'active':''}" data-index="${i}" data-action="gallery-select">`).join('')}</div>`;
  }
  return '';
})()}
            <div class="modal-price-history">
                <h4><i class="fas fa-chart-line"></i> Price History</h4>
                <canvas id="price-chart" width="300" height="120"></canvas>
                <p class="price-history-empty" id="price-history-empty">No price history yet</p>
            </div>
            <div class="modal-also-bought" id="modal-also-bought">
                <h4><i class="fas fa-shopping-bag"></i> Customers Also Bought</h4>
                <div class="also-bought-grid" id="also-bought-grid"><p class="empty-message">Loading...</p></div>
            </div>
            <div class="modal-related-products" id="modal-related">
                <h4><i class="fas fa-tags"></i> Related Products</h4>
                <div class="related-grid" id="related-grid"><p class="empty-message">Loading...</p></div>
            </div>
        </div>
        <div class="modal-details">
            <div class="modal-title-row">
                <h2 class="modal-title">${product.title}</h2>
                <button class="wishlist-btn modal-wishlist-btn ${wlActive ? 'active' : ''}" data-action="wishlist" data-id="${product.id}"><i class="fas fa-heart"></i></button>
            </div>
            <div class="modal-rating">
                <span class="stars">${renderStars(product.rating)}</span>
                <span class="rating-count">${product.ratingCount.toLocaleString()} ratings</span>
            </div>
            <div class="modal-price">
                <span class="modal-current-price">$${product.price.toFixed(2)}</span>
                ${product.originalPrice ? `<span class="original-price">$${product.originalPrice.toFixed(2)}</span>` : ''}
            </div>
            <p class="modal-description">${product.description}</p>
            <div class="modal-features">
                <h4>Features:</h4>
                <ul>${(product.features || []).map(f => `<li>${f}</li>`).join('')}</ul>
            </div>
            ${product.stock > 0 
  ? `<p class="modal-stock in-stock"><i class="fas fa-check-circle"></i> In Stock (${product.stock} units)</p>`
  : `<p class="modal-stock out-of-stock"><i class="fas fa-times-circle"></i> Out of Stock</p>`}
            ${(() => {
  let variantsHtml = '';
  if (product.variants && product.variants.length > 0) {
    variantsHtml = `<div class="modal-variants"><h4>Options:</h4>`;
    const propKeys = Object.keys(product.variants[0]).filter(k => k !== 'price' && k !== 'image');
    propKeys.forEach(key => {
      const options = [...new Set(product.variants.map(v => v[key]))];
      variantsHtml += `<label>${key}: <select class="variant-select" data-prop="${key}">${options.map(o => `<option value="${o}">${o}</option>`).join('')}</select></label> `;
    });
    variantsHtml += '</div>';
  }
  return variantsHtml;
})()}
            ${(() => {
  let galleryHtml = '';
  if (product.images && product.images.length > 1) {
    galleryHtml = `<div class="gallery-thumbs">${product.images.map((img, i) => `<img loading="lazy" src="${img}" class="gallery-thumb ${i===0?'active':''}" data-index="${i}" data-action="gallery-select">`).join('')}</div>`;
  }
  return galleryHtml;
})()}
            <div class="modal-quantity">
                <label>Quantity:</label>
                <button class="quantity-btn" onclick="decreaseModalQuantity()">-</button>
                <span class="quantity-value" id="modal-quantity">1</span>
                <button class="quantity-btn" onclick="increaseModalQuantity()">+</button>
            </div>
            <div class="modal-actions">
                <button class="modal-add-btn" data-action="modal-addcart" data-id="${product.id}">Add to Cart</button>
                <button class="modal-buy-btn" data-action="modal-buynow" data-id="${product.id}">Buy Now</button>
            </div>
            <div class="modal-reviews-section">
                <h4><i class="fas fa-star"></i> Customer Reviews</h4>
                <div class="review-form">
                    <select id="review-rating">
                        <option value="5">★★★★★</option>
                        <option value="4">★★★★☆</option>
                        <option value="3">★★★☆☆</option>
                        <option value="2">★★☆☆☆</option>
                        <option value="1">★☆☆☆☆</option>
                    </select>
                    <input type="text" id="review-comment" placeholder="Write a review..." maxlength="500">
                    <button class="review-submit-btn" data-action="review-submit" data-id="${product.id}">Submit</button>
                </div>
                <div class="modal-reviews" id="modal-reviews"><p class="empty-message">Loading reviews...</p></div>
            </div>
            <div class="modal-qa"><h4><i class="fas fa-question-circle"></i> Questions & Answers</h4><div class="qa-list" id="qa-list"><p class="empty-message">Loading...</p></div><div class="qa-form"><input type="text" id="qa-input-${product.id}" placeholder="Ask a question..."><button class="qa-ask-btn" data-action="qa-ask" data-id="${product.id}">Ask</button></div></div>
        </div>
    `;
    quickViewModal.classList.add('show');
    document.body.style.overflow = 'hidden';
    loadReviews(productId).then(reviews => renderReviews(reviews));
    loadQA(productId);
    // Related products
    fetch(`${API_BASE}/api/products/${productId}/related`).then(r => r.json()).then(related => {
        const grid = getById('related-grid');
        if (!grid) return;
        if (related.length === 0) { grid.innerHTML = '<p class="empty-message">No related products</p>'; return; }
        grid.innerHTML = related.map(p => `
            <div class="related-item" data-action="quickview" data-id="${p.id}">
                <img loading="lazy" src="${p.image}" alt="${p.title}">
                <span class="related-price">$${p.price.toFixed(2)}</span>
            </div>
        `).join('');
    });
    // Customers Also Bought
    fetch(`${API_BASE}/api/products/${productId}/also-bought`).then(r => r.json()).then(products => {
        const grid = getById('also-bought-grid');
        if (!grid) return;
        if (products.length === 0) { grid.innerHTML = '<p class="empty-message">No data yet</p>'; return; }
        grid.innerHTML = products.map(p => `
            <div class="related-item" data-action="quickview" data-id="${p.id}">
                <img loading="lazy" src="${p.image}" alt="${p.title}">
                <span class="related-price">$${p.price.toFixed(2)}</span>
            </div>
        `).join('');
    });
    // Price history
    fetch(`${API_BASE}/api/products/${productId}/price-history`).then(r => r.json()).then(data => {
        renderPriceChart(productId, data);
    });
    // Product zoom
    initProductZoom();
}

function closeModal() {
    const modal = getById('quick-view-modal');
    if (modal) { modal.classList.remove('show'); document.body.style.overflow = ''; }
}

function openCheckoutModal(items = cart, clearCartAfterCheckout = true) {
    checkoutContext = { items: items.map(item => ({ ...item })), clearCartAfterCheckout };
    if (!checkoutContext.items.length) { showToast('Your cart is empty!'); return; }
    const itemCountEl = getById('checkout-item-count');
    const summaryItemsEl = getById('checkout-summary-items');
    const summaryTotalEl = getById('checkout-summary-total');
    const checkoutModalEl = getById('checkout-modal');
    if (!itemCountEl || !summaryItemsEl || !summaryTotalEl || !checkoutModalEl) return;
    const subtotal = checkoutContext.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    itemCountEl.textContent = `${checkoutContext.items.length} item${checkoutContext.items.length === 1 ? '' : 's'}`;
    summaryItemsEl.innerHTML = checkoutContext.items.map(item => `
        <div class="checkout-summary-item">
            <img loading="lazy" src="${item.image}" alt="${item.title}">
            <div class="checkout-summary-meta">
                <strong>${item.title}</strong>
                <span>Qty: ${item.quantity}</span>
            </div>
            <span>$${(item.price * item.quantity).toFixed(2)}</span>
        </div>
    `).join('');
    summaryTotalEl.textContent = `$${subtotal.toFixed(2)}`;
    const paymentSelect = getById('checkout-payment');
    if (paymentSelect) { paymentSelect.value = 'card'; paymentSelect.dispatchEvent(new Event('change')); }
    checkoutModalEl.classList.add('show');
    document.body.style.overflow = 'hidden';
}

function closeCheckoutModal() {
    const modal = getById('checkout-modal');
    if (modal) { modal.classList.remove('show'); document.body.style.overflow = ''; checkoutContext = null; }
}

async function submitCheckout(event) {
    event.preventDefault();
    if (!checkoutContext || checkoutContext.items.length === 0) { showToast('Your cart is empty!'); return; }
    const form = getById('checkout-form');
    if (!form) return;
    const formData = new FormData(form);
    const payload = {
        customerName: String(formData.get('customerName') || '').trim(),
        email: String(formData.get('email') || '').trim(),
        address: String(formData.get('address') || '').trim(),
        paymentMethod: String(formData.get('paymentMethod') || 'card'),
        items: checkoutContext.items,
        clearCartAfterCheckout: checkoutContext.clearCartAfterCheckout,
        couponCode: checkoutContext.couponCode || '',
        giftCardCode: checkoutContext.giftCardCode || ''
    };
    if (!payload.customerName || !payload.email || !payload.address) { showToast('Please complete all checkout fields'); return; }
    try {
        const response = await fetch(`${API_BASE}/api/cart/${getSessionId()}/checkout`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        });
        if (!response.ok) throw new Error(`Checkout failed: ${response.status}`);
        const result = await response.json();
        if (payload.clearCartAfterCheckout) { cart = []; saveCart(); updateCartUI(); }
        closeCheckoutModal(); closeCart(); showToast(`Order ${result.orderId} placed successfully`);
        const successModalEl = getById('order-success-modal');
        const orderIdEl = getById('success-order-id');
        const orderPaymentEl = getById('success-order-payment');
        const orderTotalEl = getById('success-order-total');
        const instructionsBox = getById('success-instructions-box');
        const trackingEl = getById('success-tracking-code');
        const discountRow = getById('success-discount-row');
        const discountEl = getById('success-discount');
        if (successModalEl && orderIdEl && orderPaymentEl && orderTotalEl) {
            orderIdEl.textContent = result.orderId;
            orderPaymentEl.textContent = mapPaymentMethod(result.paymentMethod);
            orderTotalEl.textContent = `$${result.total.toFixed(2)}`;
            if (result.paymentMethod === 'cod' && instructionsBox) instructionsBox.style.display = 'flex';
            else if (instructionsBox) instructionsBox.style.display = 'none';
            if (trackingEl && result.trackingCode) {
                trackingEl.textContent = 'Tracking: ' + result.trackingCode;
                trackingEl.style.display = 'block';
            } else if (trackingEl) {
                trackingEl.style.display = 'none';
            }
            if (discountRow && discountEl && result.couponDiscount) {
                discountEl.textContent = '-$' + result.couponDiscount.toFixed(2);
                discountRow.style.display = 'flex';
            } else if (discountRow) {
                discountRow.style.display = 'none';
            }
            if (result.giftCardDiscount) {
              // gift card discount applied
            }
            successModalEl.classList.add('show');
            document.body.style.overflow = 'hidden';
            // If card payment, attempt payment intent
            if (result.paymentMethod === 'card') {
                try {
                    const pi = await fetch(`${API_BASE}/api/create-payment-intent`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ amount: result.total })
                    });
                    const piData = await pi.json();
                    if (piData.clientSecret) {
                        document.querySelector('#success-order-id').textContent += ` (Payment: ${piData.status})`;
                    }
                } catch {}
            }
        }
    } catch (error) {
        console.error('Checkout failed', error);
        showToast('Checkout failed. Please try again.');
    }
}

function mapPaymentMethod(method) {
    switch (method) { case 'cod': return 'Cash on Delivery'; case 'upi': return 'UPI'; default: return 'Credit / Debit Card'; }
}

function closeSuccessModal() {
    const modal = getById('order-success-modal');
    if (modal) { modal.classList.remove('show'); document.body.style.overflow = ''; }
}

function handlePaymentMethodChange() {
    const paymentSelect = getById('checkout-payment');
    const codInstructions = getById('cod-instructions');
    const submitBtn = getById('checkout-submit-btn');
    if (!paymentSelect || !submitBtn) return;
    if (paymentSelect.value === 'cod') {
        submitBtn.textContent = 'Place Cash on Delivery Order';
        if (codInstructions && checkoutContext) {
            const subtotal = checkoutContext.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
            codInstructions.innerHTML = `<i class="fas fa-money-bill-wave"></i><div><strong>Cash on Delivery selected.</strong> Please prepare $${subtotal.toFixed(2)} in cash or scan a UPI QR code at delivery.</div>`;
            codInstructions.style.display = 'flex';
        }
    } else {
        submitBtn.textContent = 'Place Order';
        if (codInstructions) codInstructions.style.display = 'none';
    }
}

function increaseModalQuantity() { modalQuantity++; const el = getById('modal-quantity'); if (el) el.textContent = modalQuantity; }
function decreaseModalQuantity() { if (modalQuantity <= 1) return; modalQuantity--; const el = getById('modal-quantity'); if (el) el.textContent = modalQuantity; }

function addToCartFromModal(productId) { addToCart(productId, modalQuantity); modalQuantity = 1; closeModal(); }

function buyNow(productId) {
    const product = getProductById(productId);
    if (!product) return;
    closeModal();
    openCheckoutModal([{ ...product, quantity: modalQuantity }], false);
}

function handleSearch() {
    const searchTerm = (getById('search-input')?.value || '').toLowerCase().trim();
    const category = getById('category-select')?.value || 'all';
    filteredProducts = products.filter(p => {
        const matchesSearch = p.title.toLowerCase().includes(searchTerm) || p.description.toLowerCase().includes(searchTerm);
        const matchesCategory = category === 'all' || p.category === category;
        return matchesSearch && matchesCategory;
    });
    applyCurrentSort();
    currentPage = 1;
    renderProducts(getPageItems());
    renderPagination();
}

function handleSort() { applyCurrentSort(); renderProducts(getPageItems()); renderPagination(); }

function applyFilters() {
  const maxPrice = parseFloat(getById('filter-price-max')?.value) || Infinity;
  const minRating = parseFloat(getById('filter-rating')?.value) || 0;
  const category = getById('category-select')?.value || 'all';
  const searchTerm = (getById('search-input')?.value || '').toLowerCase().trim();
  
  filteredProducts = products.filter(p => {
    if (searchTerm && !p.title.toLowerCase().includes(searchTerm) && !p.description.toLowerCase().includes(searchTerm)) return false;
    if (category !== 'all' && p.category !== category) return false;
    if (p.price > maxPrice) return false;
    if (p.rating < minRating) return false;
    return true;
  });
  
  currentPage = 1;
  renderProducts(getPageItems());
  renderPagination();
}

function applyCurrentSort() {
    const sortSelect = getById('sort-select');
    if (!sortSelect) return;
    switch (sortSelect.value) {
        case 'price-low': filteredProducts.sort((a, b) => a.price - b.price); break;
        case 'price-high': filteredProducts.sort((a, b) => b.price - a.price); break;
        case 'rating': filteredProducts.sort((a, b) => b.rating - a.rating); break;
        default: filteredProducts.sort((a, b) => a.id - b.id);
    }
}

function initSlider() { setInterval(() => changeSlide(1), 5000); }

function initSliderDots() {
    const slides = document.querySelectorAll('.slide');
    const dotsContainer = document.querySelector('.slider-dots');
    if (!dotsContainer) return;
    dotsContainer.innerHTML = '';
    slides.forEach((_, index) => {
        const dot = document.createElement('div');
        dot.classList.add('dot');
        if (index === 0) dot.classList.add('active');
        dot.addEventListener('click', () => goToSlide(index));
        dotsContainer.appendChild(dot);
    });
}

function changeSlide(direction) {
    const slides = document.querySelectorAll('.slide');
    const dots = document.querySelectorAll('.slider-dots .dot');
    if (!slides.length) return;
    slides[currentSlide].classList.remove('active');
    dots[currentSlide]?.classList.remove('active');
    currentSlide = (currentSlide + direction + slides.length) % slides.length;
    slides[currentSlide].classList.add('active');
    dots[currentSlide]?.classList.add('active');
}

function goToSlide(index) {
    const slides = document.querySelectorAll('.slide');
    const dots = document.querySelectorAll('.slider-dots .dot');
    if (!slides.length) return;
    slides[currentSlide].classList.remove('active');
    dots[currentSlide]?.classList.remove('active');
    currentSlide = index;
    slides[currentSlide].classList.add('active');
    dots[currentSlide]?.classList.add('active');
}

function showToast(message, isError) {
    const toast = getById('toast');
    const toastMsg = getById('toast-message');
    if (!toast || !toastMsg) return;
    toastMsg.textContent = message;
    toast.className = 'toast' + (isError ? ' toast-error' : '');
    toast.classList.add('show');
    setTimeout(() => { toast.classList.remove('show'); toast.className = 'toast'; }, 3000);
}

function debounce(func, wait) {
    let timeout;
    return function (...args) { clearTimeout(timeout); timeout = setTimeout(() => func.apply(this, args), wait); };
}

function toggleChat() {
    const panel = getById('chat-panel');
    const btn = getById('chat-button');
    if (!panel) return;
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) {
        setTimeout(() => getById('chat-input')?.focus(), 300);
        if (btn) btn.style.display = 'none';
    } else {
        if (btn) btn.style.display = 'flex';
    }
}

async function sendChat() {
    const input = getById('chat-input');
    const msg = input?.value.trim();
    if (!msg) return;
    input.value = '';
    input.disabled = true;
    const msgs = getById('chat-messages');
    msgs.insertAdjacentHTML('beforeend', `<div class="chat-msg user"><div class="msg-content">${escapeHtml(msg)}</div></div>`);
    msgs.scrollTop = msgs.scrollHeight;
    const thinkingId = 'thinking-' + Date.now();
    msgs.insertAdjacentHTML('beforeend', `<div class="chat-msg bot" id="${thinkingId}"><div class="msg-content"><i class="fas fa-spinner fa-spin"></i> Thinking...</div></div>`);
    try {
        const res = await fetch(`${API_BASE}/api/chat`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: msg })
        });
        const data = await res.json();
        const el = getById(thinkingId);
        if (el) el.outerHTML = `<div class="chat-msg bot"><div class="msg-content">${data.response}</div></div>`;
    } catch {
        const el = getById(thinkingId);
        if (el) el.outerHTML = `<div class="chat-msg bot"><div class="msg-content">Sorry, I'm having trouble connecting. Please try again later.</div></div>`;
    }
    input.disabled = false;
    input.focus();
}

function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

// ---------------------------------------------------------------------------
// Dark Mode
// ---------------------------------------------------------------------------

function toggleDarkMode() {
    document.body.classList.toggle('dark-mode');
    const isDark = document.body.classList.contains('dark-mode');
    localStorage.setItem('darkMode', isDark ? 'true' : 'false');
    const icon = getById('dark-mode-toggle')?.querySelector('i');
    if (icon) icon.className = isDark ? 'fas fa-sun' : 'fas fa-moon';
}

function initDarkMode() {
    const saved = localStorage.getItem('darkMode');
    if (saved === 'true') {
        document.body.classList.add('dark-mode');
        const icon = getById('dark-mode-toggle')?.querySelector('i');
        if (icon) icon.className = 'fas fa-sun';
    }
}

// ---------------------------------------------------------------------------
// Voice Search
// ---------------------------------------------------------------------------

function initVoiceSearch() {
    const btn = getById('voice-search-btn');
    if (!btn) return;
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
        btn.style.display = 'none';
        return;
    }
    btn.addEventListener('click', () => {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        const recognition = new SpeechRecognition();
        recognition.lang = 'en-US';
        recognition.interimResults = false;
        recognition.maxAlternatives = 1;
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
        recognition.onresult = (event) => {
            const transcript = event.results[0][0].transcript;
            const input = getById('search-input');
            if (input) { input.value = transcript; handleSearch(); }
        };
        recognition.onerror = () => {
            btn.innerHTML = '<i class="fas fa-microphone"></i>';
            btn.disabled = false;
        };
        recognition.onend = () => {
            btn.innerHTML = '<i class="fas fa-microphone"></i>';
            btn.disabled = false;
        };
        recognition.start();
    });
}

// ---------------------------------------------------------------------------
// Coupon
// ---------------------------------------------------------------------------

async function applyCoupon() {
    const codeInput = getById('checkout-coupon');
    const msgEl = getById('coupon-message');
    const code = codeInput?.value.trim();
    if (!code) { if (msgEl) { msgEl.textContent = 'Please enter a coupon code'; msgEl.className = 'coupon-message error'; } return; }
    const total = checkoutContext?.items.reduce((s, i) => s + i.price * i.quantity, 0) || 0;
    try {
        const r = await fetch(`${API_BASE}/api/coupons/validate`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, cartTotal: total })
        });
        const data = await r.json();
        if (data.valid) {
            checkoutContext.couponCode = code;
            checkoutContext.couponDiscount = data.discount;
            if (msgEl) { msgEl.textContent = `${data.description}! You save $${data.discount.toFixed(2)}`; msgEl.className = 'coupon-message success'; }
            const totalEl = getById('checkout-summary-total');
            if (totalEl) totalEl.textContent = `$${(total - data.discount).toFixed(2)}`;
        } else {
            delete checkoutContext.couponCode;
            delete checkoutContext.couponDiscount;
            if (msgEl) { msgEl.textContent = data.error || 'Invalid coupon'; msgEl.className = 'coupon-message error'; }
        }
    } catch {
        if (msgEl) { msgEl.textContent = 'Failed to validate coupon'; msgEl.className = 'coupon-message error'; }
    }
}

async function applyGiftCard() {
  const input = getById('checkout-giftcard');
  const msgEl = getById('giftcard-message');
  const code = input?.value.trim();
  if (!code) { if (msgEl) { msgEl.textContent = 'Enter a gift card code'; msgEl.className = 'coupon-message error'; } return; }
  try {
    const r = await fetch(`${API_BASE}/api/gift-cards/validate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code })
    });
    const data = await r.json();
    if (data.valid) {
      checkoutContext.giftCardCode = code;
      if (msgEl) { msgEl.textContent = `Gift card $${data.amount.toFixed(2)} applied!`; msgEl.className = 'coupon-message success'; }
    } else {
      delete checkoutContext.giftCardCode;
      if (msgEl) { msgEl.textContent = data.error || 'Invalid gift card'; msgEl.className = 'coupon-message error'; }
    }
  } catch { if (msgEl) { msgEl.textContent = 'Failed to validate gift card'; msgEl.className = 'coupon-message error'; } }
}

async function purchaseGiftCard() {
    const input = getById('giftcard-custom-amount');
    const resultEl = getById('giftcard-result');
    const amount = parseFloat(input?.value);
    if (!amount || amount < 5 || amount > 500) {
        if (resultEl) { resultEl.textContent = 'Enter an amount between $5 and $500'; resultEl.className = 'coupon-message error'; }
        return;
    }
    try {
        const r = await fetch(`${API_BASE}/api/gift-cards/purchase`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount, sessionId: getSessionId() })
        });
        const data = await r.json();
        if (data.code) {
            if (resultEl) {
                resultEl.innerHTML = `<strong>Gift Card Purchased!</strong><br>Code: <code>${data.code}</code><br>Amount: $${data.amount.toFixed(2)}`;
                resultEl.className = 'coupon-message success';
            }
        } else {
            if (resultEl) { resultEl.textContent = data.error || 'Purchase failed'; resultEl.className = 'coupon-message error'; }
        }
    } catch {
        if (resultEl) { resultEl.textContent = 'Failed to purchase gift card'; resultEl.className = 'coupon-message error'; }
    }
}

// ---------------------------------------------------------------------------
// Wishlist Share
// ---------------------------------------------------------------------------

async function shareWishlist() {
    const btn = getById('wishlist-share-btn');
    if (!btn) return;
    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating...';
    try {
        const r = await fetch(`${API_BASE}/api/wishlist/${getSessionId()}/share`);
        const data = await r.json();
        if (data.url) {
            const shareUrl = `${window.location.origin}${data.url}`;
            try {
                await navigator.clipboard.writeText(shareUrl);
                showToast('Wishlist link copied to clipboard!');
            } catch {
                showToast('Share URL: ' + shareUrl);
            }
        }
    } catch {
        showToast('Failed to generate share link');
    }
    btn.disabled = false;
    btn.innerHTML = originalHtml;
}

// Expose functions needed by dynamic content (inline onclick in modal qty buttons & chat bot links)
window.openQuickView = openQuickView;
window.addToCart = addToCart;
window.increaseModalQuantity = increaseModalQuantity;
window.decreaseModalQuantity = decreaseModalQuantity;

// Auth
async function checkAuth() {
    try {
        const r = await fetch(`${API_BASE}/api/user`);
        const data = await r.json();
        if (data.user) {
            const el = getById('nav-greeting');
            if (el) el.textContent = 'Hello, ' + data.user.name;
        }
    } catch {}
}

function openAuthModal() {
    const overlay = getById('auth-modal');
    if (overlay) overlay.style.display = 'flex';
}

function closeAuthModal() {
    const overlay = getById('auth-modal');
    if (overlay) overlay.style.display = 'none';
    const err1 = getById('auth-signin-error');
    const err2 = getById('auth-signup-error');
    if (err1) err1.textContent = '';
    if (err2) err2.textContent = '';
}

async function openProfile() {
    const overlay = getById('profile-overlay');
    if (!overlay) return;
    overlay.style.display = 'flex';
    const nameEl = getById('profile-name');
    const emailEl = getById('profile-email');
    const ordersEl = getById('profile-order-count');
    const joinedEl = getById('profile-joined');
    try {
        const r = await fetch(`${API_BASE}/api/profile`, { credentials: 'include' });
        if (!r.ok) { showToast('Please sign in first'); overlay.style.display = 'none'; return; }
        const data = await r.json();
        if (nameEl) nameEl.textContent = data.name;
        if (emailEl) emailEl.textContent = data.email;
        if (ordersEl) ordersEl.textContent = `${data.orderCount} orders`;
        if (joinedEl) joinedEl.textContent = `Joined ${data.createdAt}`;
    } catch { showToast('Failed to load profile'); }
}

function closeProfile() {
    const overlay = getById('profile-overlay');
    if (overlay) overlay.style.display = 'none';
}

async function saveProfile() {
    const nameInput = getById('profile-name-input');
    const name = nameInput?.value.trim();
    if (!name) { showToast('Name is required'); return; }
    try {
        const r = await fetch(`${API_BASE}/api/profile`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }), credentials: 'include'
        });
        if (r.ok) { showToast('Profile updated'); openProfile(); }
        else { const d = await r.json(); showToast(d.error || 'Failed'); }
    } catch { showToast('Failed to update profile'); }
}

async function changePassword() {
    const current = getById('profile-current-password')?.value;
    const newPass = getById('profile-new-password')?.value;
    const confirm = getById('profile-confirm-password')?.value;
    if (!current || !newPass) { showToast('Fill all fields'); return; }
    if (newPass !== confirm) { showToast('Passwords do not match'); return; }
    if (newPass.length < 6) { showToast('Password must be 6+ characters'); return; }
    try {
        const r = await fetch(`${API_BASE}/api/profile/password`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPassword: current, newPassword: newPass }),
            credentials: 'include'
        });
        const d = await r.json();
        if (r.ok) { showToast('Password changed!'); document.querySelectorAll('#profile-password-form input').forEach(i => i.value = ''); }
        else showToast(d.error || 'Failed');
    } catch { showToast('Failed to change password'); }
}

function switchAuthTab(tab) {
    const signinForm = getById('auth-signin-form');
    const signupForm = getById('auth-signup-form');
    const tabSignin = getById('auth-tab-signin');
    const tabSignup = getById('auth-tab-signup');
    if (tab === 'signin') {
        signinForm.style.display = ''; signupForm.style.display = 'none';
        tabSignin.classList.add('active'); tabSignup.classList.remove('active');
    } else {
        signinForm.style.display = 'none'; signupForm.style.display = '';
        tabSignin.classList.remove('active'); tabSignup.classList.add('active');
    }
    const err1 = getById('auth-signin-error');
    const err2 = getById('auth-signup-error');
    if (err1) err1.textContent = '';
    if (err2) err2.textContent = '';
}

async function signIn() {
    const email = getById('signin-email').value.trim();
    const password = getById('signin-password').value;
    const errorEl = getById('auth-signin-error');
    if (!email || !password) { errorEl.textContent = 'Please enter your email and password'; return; }
    try {
        const r = await fetch(`${API_BASE}/api/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password })
        });
        const data = await r.json();
        if (!r.ok) { errorEl.textContent = data.error || 'Login failed'; return; }
        closeAuthModal();
        const el = getById('nav-greeting');
        if (el) el.textContent = 'Hello, ' + data.user.name;
        showToast('Signed in as ' + data.user.name);
    } catch { errorEl.textContent = 'Connection error. Please try again.'; }
}

async function signUp() {
    const name = getById('signup-name').value.trim();
    const email = getById('signup-email').value.trim();
    const password = getById('signup-password').value;
    const errorEl = getById('auth-signup-error');
    if (!name || !email || !password) { errorEl.textContent = 'Please fill in all fields'; return; }
    if (password.length < 4) { errorEl.textContent = 'Password must be at least 4 characters'; return; }
    try {
        const r = await fetch(`${API_BASE}/api/signup`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, email, password })
        });
        const data = await r.json();
        if (!r.ok) { errorEl.textContent = data.error || 'Sign up failed'; return; }
        closeAuthModal();
        const el = getById('nav-greeting');
        if (el) el.textContent = 'Hello, ' + data.user.name;
        showToast('Account created! Welcome, ' + data.user.name);
    } catch { errorEl.textContent = 'Connection error. Please try again.'; }
}

window.openAuthModal = openAuthModal;
window.closeAuthModal = closeAuthModal;
window.switchAuthTab = switchAuthTab;
window.signIn = signIn;
window.signUp = signUp;
window.toggleChat = toggleChat;
window.sendChat = sendChat;
window.toggleWishlistPage = toggleWishlistPage;
