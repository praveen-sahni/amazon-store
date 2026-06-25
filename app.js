const CART_SESSION_KEY = 'amazon-cart-session-id';
const API_BASE = getApiBaseUrl();

function getApiBaseUrl() {
    const urlParams = new URLSearchParams(window.location.search);
    const apiParam = urlParams.get('api');
    if (apiParam) {
        return apiParam.replace(/\/$/, '');
    }
    const meta = document.querySelector('meta[name="api-base-url"]');
    if (meta && meta.content) {
        return meta.content.replace(/\/$/, '');
    }
    if (window.location.protocol.startsWith('http')) {
        return window.location.origin;
    }
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
let currentProductReviews = [];

const productsGrid = document.getElementById('products-grid');
const cartSidebar = document.getElementById('cart-sidebar');
const cartOverlay = document.getElementById('cart-overlay');
const cartItems = document.getElementById('cart-items');
const cartCount = document.getElementById('cart-count');
const cartSubtotal = document.getElementById('cart-subtotal');
const quickViewModal = document.getElementById('quick-view-modal');
const modalBody = document.getElementById('modal-body');
const toast = document.getElementById('toast');
const toastMessage = document.getElementById('toast-message');
const searchInput = document.getElementById('search-input');
const categorySelect = document.getElementById('category-select');
const sortSelect = document.getElementById('sort-select');
const recentlyViewedContainer = document.getElementById('recently-viewed');
const dealContainer = document.getElementById('deal-container');
const checkoutModal = document.getElementById('checkout-modal');
const checkoutForm = document.getElementById('checkout-form');
const checkoutModalClose = document.getElementById('checkout-modal-close');
const checkoutSummaryItems = document.getElementById('checkout-summary-items');
const checkoutSummaryTotal = document.getElementById('checkout-summary-total');
const checkoutItemCount = document.getElementById('checkout-item-count');

const successModal = document.getElementById('order-success-modal');
const successOrderId = document.getElementById('success-order-id');
const successOrderPayment = document.getElementById('success-order-payment');
const successOrderTotal = document.getElementById('success-order-total');
const successInstructionsBox = document.getElementById('success-instructions-box');
const successModalCloseBtn = document.getElementById('success-modal-close-btn');

const backToTopButton = document.getElementById('back-to-top');

function isElement(el) {
    return el instanceof Element;
}

function getById(id) {
    return document.getElementById(id);
}

function onReady(callback) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', callback);
    } else {
        callback();
    }
}

onReady(() => {
    renderShareableLink();
    initializeApp().catch((error) => {
        console.error('Failed to initialize application', error);
        showToast('Unable to load shop data');
    });
});

function renderShareableLink() {
    const bannerText = getById('share-link-text');
    if (!isElement(bannerText)) return;

    let shareUrl = window.location.href;
    if (window.location.protocol === 'file:' || window.location.origin === 'null') {
        shareUrl = `${window.location.protocol}//${window.location.hostname}${window.location.port ? `:${window.location.port}` : ''}${window.location.pathname}`;
    }
    bannerText.textContent = shareUrl;
    bannerText.title = 'Click to copy';
    bannerText.style.cursor = 'pointer';
    bannerText.onclick = function() {
        navigator.clipboard.writeText(shareUrl).then(() => {
            showToast('URL copied to clipboard!');
        }).catch(() => {
            showToast('Copy: ' + shareUrl);
        });
    };
}

async function initializeApp() {
    // Dynamic footer year
    const yearEl = getById('footer-year');
    if (yearEl) yearEl.textContent = new Date().getFullYear();

    // Show loading state
    if (isElement(productsGrid)) {
        productsGrid.innerHTML = '<div class="loading-state" style="grid-column:1/-1;text-align:center;padding:60px 20px"><i class="fas fa-spinner fa-spin" style="font-size:36px;color:#999;margin-bottom:16px;display:block"></i><p style="color:#999">Loading products...</p></div>';
    }

    try {
        products = await fetchProducts();
        filteredProducts = [...products];
    } catch (error) {
        console.error('Failed to load products', error);
        if (isElement(productsGrid)) {
            productsGrid.innerHTML = '<div class="error-state"><i class="fas fa-exclamation-triangle"></i><h3>Could not load products</h3><p>Make sure the server is running. <button onclick="location.reload()" class="modal-add-btn" style="margin-top:10px;display:inline-block;width:auto;padding:8px 24px">Retry</button></p></div>';
        }
        throw error;
    }

    try {
        cart = await fetchCart();
    } catch { cart = []; }

    try {
        wishlist = await fetchWishlist();
    } catch { wishlist = []; }

    renderProducts(filteredProducts);
    renderDealOfTheDay();
    renderRecentlyViewed();
    updateCartUI();
    initSlider();
    initSliderDots();
    initEventListeners();
}

async function fetchProducts() {
    const response = await fetch(`${API_BASE}/api/products`);
    if (!response.ok) {
        throw new Error(`Failed to load products: ${response.status}`);
    }
    return response.json();
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
    const product = item.product || products.find((product) => product.id === item.id);
    if (!product) {
        return { id: item.id, quantity: item.quantity || 1, title: 'Unknown item', image: '', price: 0 };
    }
    return { ...product, quantity: item.quantity || 1 };
}

async function fetchCart() {
    try {
        const response = await fetch(`${API_BASE}/api/cart/${getSessionId()}`);
        if (!response.ok) {
            return [];
        }
        const items = await response.json();
        return items.map(normalizeCartItem);
    } catch (error) {
        console.warn('Unable to load cart from backend', error);
        return [];
    }
}

async function syncCart() {
    try {
        await fetch(`${API_BASE}/api/cart/${getSessionId()}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(cart.map((item) => ({ id: item.id, quantity: item.quantity, product: normalizeProductSnapshot(item) })))
        });
    } catch (error) {
        console.warn('Cart sync failed', error);
    }
}

function saveCart() {
    localStorage.setItem('cart', JSON.stringify(cart));
    void syncCart();
}

// Wishlist API
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
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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
    if (wishlist.some(p => p.id === productId)) {
        await removeFromWishlist(productId);
    } else {
        await addToWishlist(productId);
    }
}

function isWishlisted(productId) {
    return wishlist.some(p => p.id === productId);
}

function updateWishlistUI() {
    document.querySelectorAll('.wishlist-btn').forEach(btn => {
        const pid = parseInt(btn.dataset.id);
        btn.classList.toggle('active', isWishlisted(pid));
    });
}

function toggleWishlistPage() {
    const page = document.getElementById('wishlist-page');
    const overlay = document.getElementById('wishlist-page-overlay');
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
    const container = document.getElementById('wishlist-page-content');
    if (!container) return;
    if (wishlist.length === 0) {
        container.innerHTML = '<div class="wishlist-empty"><i class="fas fa-heart-broken"></i><p>Your wishlist is empty</p></div>';
        return;
    }
    container.innerHTML = wishlist.map(p => `
        <div class="wishlist-item">
            <img src="${p.image}" alt="${p.title}" onclick="toggleWishlistPage();openQuickView(${p.id})">
            <div class="wishlist-item-info" onclick="toggleWishlistPage();openQuickView(${p.id})">
                <h4>${p.title}</h4>
                <span class="wishlist-item-price">$${p.price.toFixed(2)}</span>
            </div>
            <div class="wishlist-item-actions">
                <button class="add-to-cart-btn" onclick="addToCart(${p.id});toggleWishlistPage()">Add to Cart</button>
                <button class="remove-wishlist-btn" onclick="removeFromWishlist(${p.id})"><i class="fas fa-trash"></i></button>
            </div>
        </div>
    `).join('');
}

// Reviews
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
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ productId, sessionId: getSessionId(), rating, comment })
        });
        if (!response.ok) throw new Error('Failed');
        showToast('Review submitted');
        const reviews = await loadReviews(productId);
        renderReviews(reviews);
    } catch { showToast('Failed to submit review'); }
}

function renderReviews(reviews) {
    const container = document.getElementById('modal-reviews');
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

function initEventListeners() {
    const cartIcon = getById('cart-icon');
    const closeCartButton = getById('close-cart');
    const modalCloseButton = getById('modal-close');
    const searchButton = getById('search-btn');
    const checkoutButton = getById('checkout-btn');

    if (isElement(cartIcon)) cartIcon.addEventListener('click', openCart);
    if (isElement(closeCartButton)) closeCartButton.addEventListener('click', closeCart);
    if (isElement(cartOverlay)) cartOverlay.addEventListener('click', closeCart);
    if (isElement(modalCloseButton)) modalCloseButton.addEventListener('click', closeModal);
    if (isElement(quickViewModal)) {
        quickViewModal.addEventListener('click', (event) => {
            if (event.target === quickViewModal) closeModal();
        });
    }
    if (isElement(checkoutModalClose)) checkoutModalClose.addEventListener('click', closeCheckoutModal);
    if (isElement(checkoutModal)) {
        checkoutModal.addEventListener('click', (event) => {
            if (event.target === checkoutModal) closeCheckoutModal();
        });
    }
    if (isElement(checkoutForm)) checkoutForm.addEventListener('submit', submitCheckout);
    if (isElement(searchInput)) searchInput.addEventListener('input', debounce(handleSearch, 300));
    if (isElement(searchButton)) searchButton.addEventListener('click', handleSearch);
    if (isElement(categorySelect)) categorySelect.addEventListener('change', handleSearch);
    if (isElement(sortSelect)) sortSelect.addEventListener('change', handleSort);
    if (isElement(backToTopButton)) backToTopButton.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    if (isElement(checkoutButton)) checkoutButton.addEventListener('click', handleCheckout);
    if (isElement(successModalCloseBtn)) successModalCloseBtn.addEventListener('click', closeSuccessModal);
    if (isElement(successModal)) {
        successModal.addEventListener('click', (event) => {
            if (event.target === successModal) closeSuccessModal();
        });
    }

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            closeCart();
            closeModal();
            closeCheckoutModal();
            closeSuccessModal();
        }
    });

    document.querySelectorAll('.category-card').forEach((card) => {
        card.addEventListener('click', () => {
            categorySelect.value = card.dataset.category || 'all';
            handleSearch();
            document.querySelector('.products-section')?.scrollIntoView({ behavior: 'smooth' });
        });
    });

    document.querySelectorAll('.shop-now-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            document.querySelector('.products-section')?.scrollIntoView({ behavior: 'smooth' });
        });
    });
}

function getProductById(productId) {
    return products.find((product) => product.id === productId);
}

function renderProducts(productsToRender) {
    if (!isElement(productsGrid)) return;
    productsGrid.innerHTML = productsToRender.map((product) => `
        <div class="product-card" data-id="${product.id}">
            ${product.badge ? `<span class="product-badge ${product.badge}">${product.badge === 'deal' ? 'Deal' : 'Best Seller'}</span>` : ''}
            <button class="wishlist-btn ${isWishlisted(product.id) ? 'active' : ''}" data-id="${product.id}" onclick="event.stopPropagation();toggleWishlist(${product.id})"><i class="fas fa-heart"></i></button>
            <img src="${product.image}" alt="${product.title}" class="product-image" onclick="openQuickView(${product.id})">
            <h3 class="product-title" onclick="openQuickView(${product.id})">${product.title}</h3>
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
                <button class="add-to-cart-btn" onclick="addToCart(${product.id})">Add to Cart</button>
                <button class="quick-view-btn" onclick="openQuickView(${product.id})"><i class="fas fa-eye"></i></button>
            </div>
        </div>
    `).join('');
}

function renderStars(rating) {
    const fullStars = Math.floor(rating);
    const hasHalfStar = rating % 1 >= 0.5;
    let stars = '';

    for (let i = 0; i < fullStars; i += 1) {
        stars += '<i class="fas fa-star"></i>';
    }
    if (hasHalfStar) {
        stars += '<i class="fas fa-star-half-alt"></i>';
    }
    const emptyStars = 5 - fullStars - (hasHalfStar ? 1 : 0);
    for (let i = 0; i < emptyStars; i += 1) {
        stars += '<i class="far fa-star"></i>';
    }
    return stars;
}

function renderDealOfTheDay() {
    const dealProduct = products.find((product) => product.badge === 'deal') || products[0];
    if (!dealProduct || !isElement(dealContainer)) {
        if (isElement(dealContainer)) {
            dealContainer.innerHTML = '<p class="empty-message">No deal available</p>';
        }
        return;
    }

    dealContainer.innerHTML = `
        <img src="${dealProduct.image}" alt="${dealProduct.title}" class="deal-image">
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
            <div class="deal-price">
                <span class="deal-current-price">$${dealProduct.price.toFixed(2)}</span>
                ${dealProduct.originalPrice ? `<span class="deal-original-price">$${dealProduct.originalPrice.toFixed(2)}</span>` : ''}
            </div>
            <button class="deal-btn" onclick="addToCart(${dealProduct.id})">Add to Cart</button>
        </div>
    `;

    if (dealTimerId) {
        clearInterval(dealTimerId);
    }
    startDealTimer();
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

        const hoursElement = getById('hours');
        const minutesElement = getById('minutes');
        const secondsElement = getById('seconds');
        if (hoursElement && minutesElement && secondsElement) {
            hoursElement.textContent = h.toString().padStart(2, '0');
            minutesElement.textContent = m.toString().padStart(2, '0');
            secondsElement.textContent = s.toString().padStart(2, '0');
        }
    }

    updateTimer();
    dealTimerId = setInterval(updateTimer, 1000);
}

function addToRecentlyViewed(productId) {
    const product = getProductById(productId);
    if (!product) return;
    recentlyViewed = recentlyViewed.filter((item) => item.id !== productId);
    recentlyViewed.unshift(product);
    recentlyViewed = recentlyViewed.slice(0, 10);
    localStorage.setItem('recentlyViewed', JSON.stringify(recentlyViewed));
    renderRecentlyViewed();
}

function renderRecentlyViewed() {
    if (!isElement(recentlyViewedContainer)) return;
    if (recentlyViewed.length === 0) {
        recentlyViewedContainer.innerHTML = '<p class="empty-message">No recently viewed items</p>';
        return;
    }
    recentlyViewedContainer.innerHTML = recentlyViewed.map((product) => `
        <div class="recently-viewed-item" onclick="openQuickView(${product.id})">
            <img src="${product.image}" alt="${product.title}">
            <p class="price">$${product.price.toFixed(2)}</p>
        </div>
    `).join('');
}

function addToCart(productId, quantity = 1) {
    const product = getProductById(productId);
    if (!product) return;
    const existingItem = cart.find((item) => item.id === productId);
    if (existingItem) {
        existingItem.quantity += quantity;
    } else {
        cart.push({ ...product, quantity });
    }
    saveCart();
    updateCartUI();
    showToast(`${product.title.substring(0, 40)} added to cart`);
}

function removeFromCart(productId) {
    cart = cart.filter((item) => item.id !== productId);
    saveCart();
    updateCartUI();
}

function updateQuantity(productId, change) {
    const item = cart.find((cartItem) => cartItem.id === productId);
    if (!item) return;
    item.quantity += change;
    if (item.quantity <= 0) {
        removeFromCart(productId);
        return;
    }
    saveCart();
    updateCartUI();
}

function updateCartUI() {
    if (!isElement(cartCount) || !isElement(cartItems) || !isElement(cartSubtotal)) return;
    const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
    cartCount.textContent = totalItems;
    if (cart.length === 0) {
        cartItems.innerHTML = `
            <div class="cart-empty">
                <i class="fas fa-shopping-cart"></i>
                <p>Your cart is empty</p>
            </div>
        `;
    } else {
        cartItems.innerHTML = cart.map((item) => `
            <div class="cart-item">
                <img src="${item.image}" alt="${item.title}" class="cart-item-image">
                <div class="cart-item-details">
                    <h4 class="cart-item-title">${item.title}</h4>
                    <p class="cart-item-price">$${item.price.toFixed(2)}</p>
                    <div class="cart-item-quantity">
                        <button class="quantity-btn" onclick="updateQuantity(${item.id}, -1)">-</button>
                        <span class="quantity-value">${item.quantity}</span>
                        <button class="quantity-btn" onclick="updateQuantity(${item.id}, 1)">+</button>
                        <button class="remove-item" onclick="removeFromCart(${item.id})">Delete</button>
                    </div>
                </div>
            </div>
        `).join('');
    }
    const subtotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
    cartSubtotal.textContent = `$${subtotal.toFixed(2)}`;
}

function openCart() {
    if (isElement(cartSidebar) && isElement(cartOverlay)) {
        cartSidebar.classList.add('open');
        cartOverlay.classList.add('show');
        document.body.style.overflow = 'hidden';
    }
}

function closeCart() {
    if (isElement(cartSidebar) && isElement(cartOverlay)) {
        cartSidebar.classList.remove('open');
        cartOverlay.classList.remove('show');
        document.body.style.overflow = '';
    }
}

function handleCheckout() {
    if (cart.length === 0) {
        showToast('Your cart is empty!');
        return;
    }
    openCheckoutModal(cart, true);
}

function openQuickView(productId) {
    const product = getProductById(productId);
    if (!product) return;
    addToRecentlyViewed(productId);
    modalQuantity = 1;
    if (!isElement(modalBody) || !isElement(quickViewModal)) return;
    const wlActive = isWishlisted(productId);
    modalBody.innerHTML = `
        <div class="modal-image-col">
            <img src="${product.image}" alt="${product.title}" class="modal-image">
            <div class="modal-related-products" id="modal-related">
                <h4><i class="fas fa-tags"></i> Related Products</h4>
                <div class="related-grid" id="related-grid"><p class="empty-message">Loading...</p></div>
            </div>
        </div>
        <div class="modal-details">
            <div class="modal-title-row">
                <h2 class="modal-title">${product.title}</h2>
                <button class="wishlist-btn modal-wishlist-btn ${wlActive ? 'active' : ''}" onclick="toggleWishlist(${product.id})"><i class="fas fa-heart"></i></button>
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
                <ul>${(product.features || []).map((feature) => `<li>${feature}</li>`).join('')}</ul>
            </div>
            <div class="modal-quantity">
                <label>Quantity:</label>
                <button class="quantity-btn" onclick="decreaseModalQuantity()">-</button>
                <span class="quantity-value" id="modal-quantity">1</span>
                <button class="quantity-btn" onclick="increaseModalQuantity()">+</button>
            </div>
            <div class="modal-actions">
                <button class="modal-add-btn" onclick="addToCartFromModal(${product.id})">Add to Cart</button>
                <button class="modal-buy-btn" onclick="buyNow(${product.id})">Buy Now</button>
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
                    <button class="review-submit-btn" onclick="submitReview(${product.id}, parseInt(document.getElementById('review-rating').value), document.getElementById('review-comment').value); document.getElementById('review-comment').value=''; document.getElementById('review-rating').value='5';">Submit</button>
                </div>
                <div class="modal-reviews" id="modal-reviews"><p class="empty-message">Loading reviews...</p></div>
            </div>
        </div>
    `;
    quickViewModal.classList.add('show');
    document.body.style.overflow = 'hidden';
    loadReviews(productId).then(reviews => renderReviews(reviews));
    fetch(`${API_BASE}/api/products/${productId}/related`).then(r => r.json()).then(related => {
        const grid = document.getElementById('related-grid');
        if (!grid) return;
        if (related.length === 0) { grid.innerHTML = '<p class="empty-message">No related products</p>'; return; }
        grid.innerHTML = related.map(p => `
            <div class="related-item" onclick="closeModal();openQuickView(${p.id})">
                <img src="${p.image}" alt="${p.title}">
                <span class="related-price">$${p.price.toFixed(2)}</span>
            </div>
        `).join('');
    });
}

function closeModal() {
    if (isElement(quickViewModal)) {
        quickViewModal.classList.remove('show');
        document.body.style.overflow = '';
    }
}

function openCheckoutModal(items = cart, clearCartAfterCheckout = true) {
    checkoutContext = { items: items.map((item) => ({ ...item })), clearCartAfterCheckout };
    if (!checkoutContext.items.length) {
        showToast('Your cart is empty!');
        return;
    }
    if (!isElement(checkoutItemCount) || !isElement(checkoutSummaryItems) || !isElement(checkoutSummaryTotal) || !isElement(checkoutModal)) return;
    const subtotal = checkoutContext.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    checkoutItemCount.textContent = `${checkoutContext.items.length} item${checkoutContext.items.length === 1 ? '' : 's'}`;
    checkoutSummaryItems.innerHTML = checkoutContext.items.map((item) => `
        <div class="checkout-summary-item">
            <img src="${item.image}" alt="${item.title}">
            <div class="checkout-summary-meta">
                <strong>${item.title}</strong>
                <span>Qty: ${item.quantity}</span>
            </div>
            <span>$${(item.price * item.quantity).toFixed(2)}</span>
        </div>
    `).join('');
    checkoutSummaryTotal.textContent = `$${subtotal.toFixed(2)}`;
    const paymentSelect = getById('checkout-payment');
    if (paymentSelect) paymentSelect.value = 'card';
    handlePaymentMethodChange();
    checkoutModal.classList.add('show');
    document.body.style.overflow = 'hidden';
}

function closeCheckoutModal() {
    if (isElement(checkoutModal)) {
        checkoutModal.classList.remove('show');
        document.body.style.overflow = '';
        checkoutContext = null;
    }
}

async function submitCheckout(event) {
    event.preventDefault();
    if (!checkoutContext || checkoutContext.items.length === 0) {
        showToast('Your cart is empty!');
        return;
    }
    const formData = new FormData(checkoutForm);
    const payload = {
        customerName: String(formData.get('customerName') || '').trim(),
        email: String(formData.get('email') || '').trim(),
        address: String(formData.get('address') || '').trim(),
        paymentMethod: String(formData.get('paymentMethod') || 'card'),
        items: checkoutContext.items,
        clearCartAfterCheckout: checkoutContext.clearCartAfterCheckout
    };
    if (!payload.customerName || !payload.email || !payload.address) {
        showToast('Please complete all checkout fields');
        return;
    }
    try {
        const response = await fetch(`${API_BASE}/api/cart/${getSessionId()}/checkout`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) throw new Error(`Checkout failed: ${response.status}`);
        const result = await response.json();
        if (payload.clearCartAfterCheckout) {
            cart = [];
            saveCart();
            updateCartUI();
        }
        closeCheckoutModal();
        closeCart();
        showToast(`Order ${result.orderId} placed successfully`);
        if (isElement(successModal) && isElement(successOrderId) && isElement(successOrderPayment) && isElement(successOrderTotal)) {
            successOrderId.textContent = result.orderId;
            successOrderPayment.textContent = mapPaymentMethod(result.paymentMethod);
            successOrderTotal.textContent = `$${result.total.toFixed(2)}`;
            if (result.paymentMethod === 'cod' && isElement(successInstructionsBox)) {
                successInstructionsBox.style.display = 'flex';
            } else if (isElement(successInstructionsBox)) {
                successInstructionsBox.style.display = 'none';
            }
            successModal.classList.add('show');
            document.body.style.overflow = 'hidden';
        }
    } catch (error) {
        console.error('Checkout failed', error);
        showToast('Checkout failed. Please try again.');
    }
}

function mapPaymentMethod(method) {
    switch (method) {
        case 'cod': return 'Cash on Delivery';
        case 'upi': return 'UPI';
        default: return 'Credit / Debit Card';
    }
}

function closeSuccessModal() {
    if (isElement(successModal)) {
        successModal.classList.remove('show');
        document.body.style.overflow = '';
    }
}

function handlePaymentMethodChange() {
    const paymentSelect = getById('checkout-payment');
    const codInstructions = getById('cod-instructions');
    const submitBtn = getById('checkout-submit-btn');
    if (!paymentSelect || !isElement(submitBtn)) return;
    if (paymentSelect.value === 'cod') {
        submitBtn.textContent = 'Place Cash on Delivery Order';
        if (isElement(codInstructions) && checkoutContext) {
            const subtotal = checkoutContext.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
            codInstructions.innerHTML = `<i class="fas fa-money-bill-wave"></i><div><strong>Cash on Delivery selected.</strong> Please prepare $${subtotal.toFixed(2)} in cash or scan a UPI QR code at delivery.</div>`;
            codInstructions.style.display = 'flex';
        }
    } else {
        submitBtn.textContent = 'Place Order';
        if (isElement(codInstructions)) codInstructions.style.display = 'none';
    }
}

function increaseModalQuantity() {
    modalQuantity += 1;
    const quantityElement = getById('modal-quantity');
    if (isElement(quantityElement)) quantityElement.textContent = modalQuantity;
}

function decreaseModalQuantity() {
    if (modalQuantity <= 1) return;
    modalQuantity -= 1;
    const quantityElement = getById('modal-quantity');
    if (isElement(quantityElement)) quantityElement.textContent = modalQuantity;
}

function addToCartFromModal(productId) {
    addToCart(productId, modalQuantity);
    modalQuantity = 1;
    closeModal();
}

function buyNow(productId) {
    const product = getProductById(productId);
    if (!product) return;
    closeModal();
    openCheckoutModal([{ ...product, quantity: modalQuantity }], false);
}

function handleSearch() {
    const searchTerm = (searchInput?.value || '').toLowerCase().trim();
    const category = categorySelect?.value || 'all';
    filteredProducts = products.filter((product) => {
        const matchesSearch = product.title.toLowerCase().includes(searchTerm) || product.description.toLowerCase().includes(searchTerm);
        const matchesCategory = category === 'all' || product.category === category;
        return matchesSearch && matchesCategory;
    });
    applyCurrentSort();
    renderProducts(filteredProducts);
}

function handleSort() {
    applyCurrentSort();
    renderProducts(filteredProducts);
}

function applyCurrentSort() {
    if (!sortSelect) return;
    switch (sortSelect.value) {
        case 'price-low':
            filteredProducts.sort((a, b) => a.price - b.price);
            break;
        case 'price-high':
            filteredProducts.sort((a, b) => b.price - a.price);
            break;
        case 'rating':
            filteredProducts.sort((a, b) => b.rating - a.rating);
            break;
        default:
            filteredProducts.sort((a, b) => a.id - b.id);
    }
}

function initSlider() {
    setInterval(() => changeSlide(1), 5000);
}

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

function showToast(message) {
    if (!isElement(toast) || !isElement(toastMessage)) return;
    toastMessage.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
}

function debounce(func, wait) {
    let timeout;
    return function (...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

function toggleChat() {
    const panel = getById('chat-panel');
    const btn = getById('chat-button');
    if (panel) {
        panel.classList.toggle('open');
        if (panel.classList.contains('open')) {
            setTimeout(() => getById('chat-input')?.focus(), 300);
            btn.style.display = 'none';
        } else {
            btn.style.display = 'flex';
        }
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
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg })
        });
        const data = await res.json();
        const el = getById(thinkingId);
        if (el) {
            el.outerHTML = `<div class="chat-msg bot"><div class="msg-content">${data.response}</div></div>`;
        }
    } catch {
        const el = getById(thinkingId);
        if (el) {
            el.outerHTML = `<div class="chat-msg bot"><div class="msg-content">Sorry, I'm having trouble connecting. Please try again later.</div></div>`;
        }
    }

    input.disabled = false;
    input.focus();
}

function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

window.toggleChat = toggleChat;
window.sendChat = sendChat;
window.addToCart = addToCart;
window.removeFromCart = removeFromCart;
window.updateQuantity = updateQuantity;
window.openQuickView = openQuickView;
window.increaseModalQuantity = increaseModalQuantity;
window.decreaseModalQuantity = decreaseModalQuantity;
window.addToCartFromModal = addToCartFromModal;
window.buyNow = buyNow;
window.toggleWishlist = toggleWishlist;
window.submitReview = submitReview;
window.toggleWishlistPage = toggleWishlistPage;
window.removeFromWishlist = removeFromWishlist;
