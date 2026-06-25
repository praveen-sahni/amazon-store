"""
Amazon Clone — Python Flask Backend
Provides REST API for products, cart, checkout, reviews, wishlist, and admin.
"""

import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone

from flask import Flask, g, jsonify, request, send_from_directory, render_template_string

app = Flask(__name__, static_folder=None)

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "amazon.db")
SEED_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data.sql")


# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------

def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA journal_mode=WAL")
        g.db.execute("PRAGMA foreign_keys=ON")
    return g.db


def close_db(_exc=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    db = sqlite3.connect(DB_PATH)
    db.executescript("""
        CREATE TABLE IF NOT EXISTS products (
            id              INTEGER PRIMARY KEY,
            title           TEXT    NOT NULL,
            image           TEXT    NOT NULL,
            price           REAL    NOT NULL,
            original_price  REAL,
            rating          REAL    NOT NULL,
            rating_count    INTEGER NOT NULL,
            category        TEXT    NOT NULL,
            badge           TEXT,
            description     TEXT    NOT NULL,
            features        TEXT
        );

        CREATE TABLE IF NOT EXISTS carts (
            session_id  TEXT PRIMARY KEY,
            items       TEXT NOT NULL DEFAULT '[]',
            updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS customer_orders (
            order_id        TEXT PRIMARY KEY,
            session_id      TEXT    NOT NULL,
            customer_name   TEXT    NOT NULL,
            email           TEXT    NOT NULL,
            address         TEXT    NOT NULL,
            payment_method  TEXT    NOT NULL,
            total           REAL    NOT NULL,
            item_count      INTEGER NOT NULL,
            created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS order_items (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id    TEXT    NOT NULL REFERENCES customer_orders(order_id) ON DELETE CASCADE,
            product_id  INTEGER NOT NULL,
            title       TEXT    NOT NULL,
            price       REAL    NOT NULL,
            quantity    INTEGER NOT NULL,
            image       TEXT    NOT NULL
        );

        CREATE TABLE IF NOT EXISTS reviews (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
            session_id  TEXT    NOT NULL,
            rating      INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
            comment     TEXT    NOT NULL DEFAULT '',
            created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS wishlists (
            session_id  TEXT    NOT NULL,
            product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
            added_at    TEXT    NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (session_id, product_id)
        );

    """)
    # Add status column if not present
    try:
        db.execute("ALTER TABLE customer_orders ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'")
    except sqlite3.OperationalError:
        pass
    # Seed products if table is empty
    count = db.execute("SELECT COUNT(*) FROM products").fetchone()[0]
    if count == 0 and os.path.isfile(SEED_PATH):
        with open(SEED_PATH, encoding="utf-8") as f:
            seed_sql = f.read()
        for stmt in seed_sql.split("\n\n"):
            stmt = stmt.strip().rstrip(";")
            if stmt and stmt.upper().startswith("INSERT"):
                db.execute(stmt)
        db.commit()
    db.close()


# ---------------------------------------------------------------------------
# Health endpoint
# ---------------------------------------------------------------------------


@app.route("/api/health")
def health():
    return jsonify({"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()})


# ---------------------------------------------------------------------------
# Product helpers
# ---------------------------------------------------------------------------

def row_to_product(row):
    features = []
    if row["features"]:
        features = [f.strip() for f in row["features"].split("|") if f.strip()]
    return {
        "id": row["id"],
        "title": row["title"],
        "image": row["image"],
        "price": row["price"],
        "originalPrice": row["original_price"],
        "rating": row["rating"],
        "ratingCount": row["rating_count"],
        "category": row["category"],
        "badge": row["badge"],
        "description": row["description"],
        "features": features,
    }


# ---------------------------------------------------------------------------
# Routes — Products
# ---------------------------------------------------------------------------

@app.route("/api/products", methods=["GET"])
def list_products():
    db = get_db()
    rows = db.execute("SELECT * FROM products ORDER BY id").fetchall()
    return jsonify([row_to_product(r) for r in rows])


@app.route("/api/products/<int:product_id>", methods=["GET"])
def get_product(product_id):
    db = get_db()
    row = db.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
    if row is None:
        return jsonify({"error": "Not found"}), 404
    return jsonify(row_to_product(row))


@app.route("/api/products/category/<category>", methods=["GET"])
def products_by_category(category):
    db = get_db()
    rows = db.execute(
        "SELECT * FROM products WHERE LOWER(category) = LOWER(?) ORDER BY id",
        (category,),
    ).fetchall()
    return jsonify([row_to_product(r) for r in rows])


@app.route("/api/products/deal", methods=["GET"])
def deal_of_day():
    db = get_db()
    row = db.execute(
        "SELECT * FROM products WHERE LOWER(badge) = 'deal' ORDER BY id LIMIT 1"
    ).fetchone()
    if row is None:
        return jsonify({"error": "No deal available"}), 404
    return jsonify(row_to_product(row))


# ---------------------------------------------------------------------------
# Routes — Cart
# ---------------------------------------------------------------------------


def get_cart_items(session_id):
    db = get_db()
    row = db.execute("SELECT items FROM carts WHERE session_id = ?", (session_id,)).fetchone()
    if row is None:
        return []
    return json.loads(row["items"])


def save_cart_items(session_id, items):
    db = get_db()
    db.execute(
        "INSERT INTO carts (session_id, items, updated_at) VALUES (?, ?, datetime('now')) "
        "ON CONFLICT(session_id) DO UPDATE SET items=excluded.items, updated_at=excluded.updated_at",
        (session_id, json.dumps(items)),
    )
    db.commit()


@app.route("/api/cart/<session_id>", methods=["GET"])
def cart_get(session_id):
    items = get_cart_items(session_id)
    return jsonify(items)


@app.route("/api/cart/<session_id>", methods=["POST"])
def cart_save(session_id):
    body = request.get_json(silent=True) or []
    save_cart_items(session_id, body)
    return jsonify({"ok": True})


@app.route("/api/cart/<session_id>", methods=["DELETE"])
def cart_clear(session_id):
    db = get_db()
    db.execute("DELETE FROM carts WHERE session_id = ?", (session_id,))
    db.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Routes — Checkout
# ---------------------------------------------------------------------------

@app.route("/api/cart/<session_id>/checkout", methods=["POST"])
def checkout(session_id):
    body = request.get_json(silent=True) or {}
    items = body.get("items", [])
    if not items:
        return jsonify({"error": "Cart is empty"}), 400

    total = 0.0
    resolved_items = []
    db = get_db()

    for item in items:
        pid = item.get("id")
        qty = item.get("quantity", 1)
        product_snapshot = item.get("product")

        if product_snapshot:
            price = product_snapshot.get("price", 0)
            title = product_snapshot.get("title", "Unknown")
            image = product_snapshot.get("image", "")
        else:
            row = db.execute("SELECT * FROM products WHERE id = ?", (pid,)).fetchone()
            if row is None:
                continue
            price = row["price"]
            title = row["title"]
            image = row["image"]

        line_total = price * qty
        total += line_total
        resolved_items.append(
            {
                "product_id": pid,
                "title": title,
                "price": price,
                "quantity": qty,
                "image": image,
            }
        )

    order_id = f"ORD-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid.uuid4().hex[:6].upper()}"

    db.execute(
        "INSERT INTO customer_orders (order_id, session_id, customer_name, email, address, payment_method, total, item_count) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            order_id,
            session_id,
            body.get("customerName", ""),
            body.get("email", ""),
            body.get("address", ""),
            body.get("paymentMethod", "card"),
            round(total, 2),
            len(resolved_items),
        ),
    )

    for ri in resolved_items:
        db.execute(
            "INSERT INTO order_items (order_id, product_id, title, price, quantity, image) VALUES (?, ?, ?, ?, ?, ?)",
            (
                order_id,
                ri["product_id"],
                ri["title"],
                ri["price"],
                ri["quantity"],
                ri["image"],
            ),
        )

    db.commit()

    if body.get("clearCartAfterCheckout", True):
        db.execute("DELETE FROM carts WHERE session_id = ?", (session_id,))
        db.commit()

    return jsonify(
        {
            "orderId": order_id,
            "total": round(total, 2),
            "itemCount": len(resolved_items),
            "paymentMethod": body.get("paymentMethod", "card"),
            "customerName": body.get("customerName", ""),
        }
    )


# ---------------------------------------------------------------------------
# Routes — Orders
# ---------------------------------------------------------------------------

@app.route("/api/orders", methods=["GET"])
def list_orders():
    db = get_db()
    rows = db.execute("SELECT * FROM customer_orders ORDER BY created_at DESC").fetchall()
    return jsonify(
        [
            {
                "orderId": r["order_id"],
                "customerName": r["customer_name"],
                "email": r["email"],
                "total": r["total"],
                "paymentMethod": r["payment_method"],
                "itemCount": r["item_count"],
                "createdAt": r["created_at"],
            }
            for r in rows
        ]
    )


@app.route("/api/orders/<order_id>", methods=["GET"])
def get_order(order_id):
    db = get_db()
    row = db.execute("SELECT * FROM customer_orders WHERE order_id = ?", (order_id,)).fetchone()
    if row is None:
        return jsonify({"error": "Not found"}), 404
    items = db.execute(
        "SELECT * FROM order_items WHERE order_id = ?", (order_id,)
    ).fetchall()
    return jsonify(
        {
            "orderId": row["order_id"],
            "customerName": row["customer_name"],
            "email": row["email"],
            "address": row["address"],
            "paymentMethod": row["payment_method"],
            "total": row["total"],
            "itemCount": row["item_count"],
            "createdAt": row["created_at"],
            "items": [
                {
                    "productId": i["product_id"],
                    "title": i["title"],
                    "price": i["price"],
                    "quantity": i["quantity"],
                    "image": i["image"],
                }
                for i in items
            ],
        }
    )


# ---------------------------------------------------------------------------
# Routes — Reviews
# ---------------------------------------------------------------------------

@app.route("/api/reviews/<int:product_id>", methods=["GET"])
def list_reviews(product_id):
    db = get_db()
    rows = db.execute(
        "SELECT * FROM reviews WHERE product_id = ? ORDER BY created_at DESC", (product_id,)
    ).fetchall()
    return jsonify([
        {
            "id": r["id"],
            "productId": r["product_id"],
            "sessionId": r["session_id"],
            "rating": r["rating"],
            "comment": r["comment"],
            "createdAt": r["created_at"],
        }
        for r in rows
    ])


@app.route("/api/reviews", methods=["POST"])
def add_review():
    body = request.get_json(silent=True) or {}
    product_id = body.get("productId")
    session_id = body.get("sessionId", "anonymous")
    rating = body.get("rating", 5)
    comment = body.get("comment", "")
    if not product_id:
        return jsonify({"error": "productId required"}), 400
    rating = max(1, min(5, rating))
    db = get_db()
    db.execute(
        "INSERT INTO reviews (product_id, session_id, rating, comment) VALUES (?, ?, ?, ?)",
        (product_id, session_id, rating, comment),
    )
    db.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Routes — Wishlist
# ---------------------------------------------------------------------------

@app.route("/api/wishlist/<session_id>", methods=["GET"])
def wishlist_get(session_id):
    db = get_db()
    rows = db.execute(
        """SELECT p.* FROM wishlists w
           JOIN products p ON p.id = w.product_id
           WHERE w.session_id = ?
           ORDER BY w.added_at DESC""",
        (session_id,),
    ).fetchall()
    return jsonify([row_to_product(r) for r in rows])


@app.route("/api/wishlist/<session_id>", methods=["POST"])
def wishlist_add(session_id):
    body = request.get_json(silent=True) or {}
    product_id = body.get("productId")
    if not product_id:
        return jsonify({"error": "productId required"}), 400
    db = get_db()
    db.execute(
        "INSERT OR IGNORE INTO wishlists (session_id, product_id) VALUES (?, ?)",
        (session_id, product_id),
    )
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/wishlist/<session_id>/<int:product_id>", methods=["DELETE"])
def wishlist_remove(session_id, product_id):
    db = get_db()
    db.execute(
        "DELETE FROM wishlists WHERE session_id = ? AND product_id = ?",
        (session_id, product_id),
    )
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/wishlist/<session_id>/check/<int:product_id>", methods=["GET"])
def wishlist_check(session_id, product_id):
    db = get_db()
    row = db.execute(
        "SELECT 1 FROM wishlists WHERE session_id = ? AND product_id = ?",
        (session_id, product_id),
    ).fetchone()
    return jsonify({"wishlisted": row is not None})


# ---------------------------------------------------------------------------
# Routes — Related Products
# ---------------------------------------------------------------------------

@app.route("/api/products/<int:product_id>/related", methods=["GET"])
def related_products(product_id):
    db = get_db()
    product = db.execute("SELECT category FROM products WHERE id = ?", (product_id,)).fetchone()
    if product is None:
        return jsonify([])
    rows = db.execute(
        "SELECT * FROM products WHERE category = ? AND id != ? ORDER BY RANDOM() LIMIT 4",
        (product["category"], product_id),
    ).fetchall()
    return jsonify([row_to_product(r) for r in rows])


# ---------------------------------------------------------------------------
# Routes — Admin
# ---------------------------------------------------------------------------

@app.route("/api/admin/orders", methods=["GET"])
def admin_list_orders():
    db = get_db()
    rows = db.execute(
        "SELECT * FROM customer_orders ORDER BY created_at DESC"
    ).fetchall()
    result = []
    for r in rows:
        items = db.execute(
            "SELECT * FROM order_items WHERE order_id = ?", (r["order_id"],)
        ).fetchall()
        result.append({
            "orderId": r["order_id"],
            "sessionId": r["session_id"],
            "customerName": r["customer_name"],
            "email": r["email"],
            "address": r["address"],
            "paymentMethod": r["payment_method"],
            "total": r["total"],
            "itemCount": r["item_count"],
            "status": r["status"],
            "createdAt": r["created_at"],
            "items": [
                {"productId": i["product_id"], "title": i["title"],
                 "price": i["price"], "quantity": i["quantity"], "image": i["image"]}
                for i in items
            ],
        })
    return jsonify(result)


@app.route("/api/admin/orders/<order_id>/status", methods=["POST"])
def admin_update_order_status(order_id):
    body = request.get_json(silent=True) or {}
    status = body.get("status", "pending")
    valid = ("pending", "confirmed", "shipped", "delivered", "cancelled")
    if status not in valid:
        return jsonify({"error": f"Invalid status. Valid: {', '.join(valid)}"}), 400
    db = get_db()
    db.execute("UPDATE customer_orders SET status = ? WHERE order_id = ?", (status, order_id))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/admin/products", methods=["GET"])
def admin_list_products():
    db = get_db()
    rows = db.execute("SELECT * FROM products ORDER BY id").fetchall()
    return jsonify([row_to_product(r) for r in rows])


@app.route("/api/admin/stats", methods=["GET"])
def admin_stats():
    db = get_db()
    total_orders = db.execute("SELECT COUNT(*) FROM customer_orders").fetchone()[0]
    total_revenue = db.execute("SELECT COALESCE(SUM(total), 0) FROM customer_orders").fetchone()[0]
    total_products = db.execute("SELECT COUNT(*) FROM products").fetchone()[0]
    total_reviews = db.execute("SELECT COUNT(*) FROM reviews").fetchone()[0]
    return jsonify({
        "totalOrders": total_orders,
        "totalRevenue": round(total_revenue, 2),
        "totalProducts": total_products,
        "totalReviews": total_reviews,
    })


_ADMIN_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Admin — Amazon Clone</title>
<link rel="stylesheet" href="style.css">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<style>
.admin-header{background:var(--amazon-blue);color:#fff;padding:15px 25px;display:flex;justify-content:space-between;align-items:center;}
.admin-header h1{font-size:20px;margin:0;}
.admin-header a{color:var(--amazon-orange);text-decoration:none;font-size:14px;}
.admin-layout{display:flex;min-height:calc(100vh - 60px);}
.admin-sidebar{width:220px;background:var(--amazon-blue-light);color:#fff;padding:20px;}
.admin-sidebar a{display:block;color:#ddd;padding:10px 15px;text-decoration:none;border-radius:6px;margin-bottom:5px;font-size:14px;}
.admin-sidebar a:hover,.admin-sidebar a.active{background:rgba(255,255,255,0.1);color:#fff;}
.admin-main{flex:1;padding:25px;background:var(--bg-gray);}
.admin-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:15px;margin-bottom:30px;}
.stat-card{background:#fff;padding:20px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.1);}
.stat-card .num{font-size:28px;font-weight:bold;color:var(--amazon-blue);}
.stat-card .label{font-size:13px;color:var(--text-gray);margin-top:5px;}
.admin-table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);}
.admin-table th,.admin-table td{padding:12px 15px;text-align:left;border-bottom:1px solid #eee;font-size:14px;}
.admin-table th{background:#f7f7f7;font-weight:bold;color:var(--text-dark);}
.admin-table tr:hover{background:#fafafa;}
.status-badge{padding:3px 10px;border-radius:12px;font-size:12px;font-weight:bold;}
.status-badge.pending{background:#fff3cd;color:#856404;}
.status-badge.confirmed{background:#cce5ff;color:#004085;}
.status-badge.shipped{background:#d4edda;color:#155724;}
.status-badge.delivered{background:#d1ecf1;color:#0c5460;}
.status-badge.cancelled{background:#f8d7da;color:#721c24;}
.admin-tabs{display:flex;gap:10px;margin-bottom:20px;}
.admin-tabs button{padding:8px 20px;border:1px solid var(--border-gray);border-radius:6px;background:#fff;cursor:pointer;font-size:14px;}
.admin-tabs button.active{background:var(--amazon-blue);color:#fff;border-color:var(--amazon-blue);}
.status-select{padding:4px 8px;border:1px solid var(--border-gray);border-radius:4px;font-size:13px;}
@media(max-width:768px){.admin-layout{flex-direction:column}.admin-sidebar{width:100%;padding:10px 15px;display:flex;gap:8px;overflow-x:auto}.admin-sidebar a{white-space:nowrap;margin:0;flex-shrink:0}.admin-main{padding:15px}.admin-stats{grid-template-columns:repeat(2,1fr);gap:10px}.stat-card{padding:14px}.stat-card .num{font-size:22px}.admin-table{font-size:13px}.admin-table th,.admin-table td{padding:8px 10px}.admin-header{padding:12px 16px}.admin-header h1{font-size:16px}}@media(max-width:480px){.admin-stats{grid-template-columns:1fr}.admin-table th,.admin-table td{padding:6px 8px;font-size:12px}.admin-table td:nth-child(3),.admin-table th:nth-child(3){display:none}}
</style>
</head>
<body>
<div class="admin-header">
<h1><i class="fas fa-cog"></i> Admin Dashboard</h1>
<a href="/"><i class="fas fa-store"></i> Back to Store</a>
</div>
<div class="admin-layout">
<div class="admin-sidebar">
<a href="#" class="active" data-tab="orders"><i class="fas fa-shopping-bag"></i> Orders</a>
<a href="#" data-tab="products"><i class="fas fa-box"></i> Products</a>
<a href="#" data-tab="reviews"><i class="fas fa-star"></i> Reviews</a>
</div>
<div class="admin-main" id="admin-main">
<div class="admin-stats" id="admin-stats"></div>
<div id="admin-content"></div>
</div>
</div>
<script>
const API=window.location.origin;
let state={};
async function loadStats(){try{const r=await fetch(API+'/api/admin/stats');if(r.ok)state.stats=await r.json();else state.stats=null}catch{state.stats=null}
const s=document.getElementById('admin-stats');if(!state.stats){s.innerHTML='<p>Could not load stats</p>';return}
s.innerHTML=\`
<div class="stat-card"><div class="num">\${state.stats.totalOrders}</div><div class="label">Total Orders</div></div>
<div class="stat-card"><div class="num">$\${state.stats.totalRevenue.toFixed(2)}</div><div class="label">Total Revenue</div></div>
<div class="stat-card"><div class="num">\${state.stats.totalProducts}</div><div class="label">Products</div></div>
<div class="stat-card"><div class="num">\${state.stats.totalReviews}</div><div class="label">Reviews</div></div>
\`}
async function loadOrders(){const r=await fetch(API+'/api/admin/orders');const orders=await r.json();const el=document.getElementById('admin-content');
el.innerHTML='<div class="admin-tabs"><button class="active">All</button></div><table class="admin-table"><thead><tr><th>Order ID</th><th>Customer</th><th>Email</th><th>Items</th><th>Total</th><th>Payment</th><th>Status</th><th>Date</th></tr></thead><tbody>'+
orders.map(o=>\`<tr><td style="font-size:12px">\${o.orderId}</td><td>\${o.customerName}</td><td>\${o.email}</td><td>\${o.itemCount}</td><td>$\${o.total.toFixed(2)}</td><td>\${o.paymentMethod}</td>
<td><select class="status-select" data-order="\${o.orderId}" onchange="updateStatus('\${o.orderId}',this.value)">
<option value="pending"\${o.status==='pending'?' selected':''}>Pending</option>
<option value="confirmed"\${o.status==='confirmed'?' selected':''}>Confirmed</option>
<option value="shipped"\${o.status==='shipped'?' selected':''}>Shipped</option>
<option value="delivered"\${o.status==='delivered'?' selected':''}>Delivered</option>
<option value="cancelled"\${o.status==='cancelled'?' selected':''}>Cancelled</option>
</select></td>
<td>\${o.createdAt||''}</td></tr>\`).join('')+'</tbody></table>';}
async function updateStatus(orderId,status){await fetch(API+'/api/admin/orders/'+orderId+'/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})});}
async function loadProducts(){const r=await fetch(API+'/api/admin/products');const products=await r.json();const el=document.getElementById('admin-content');
el.innerHTML='<table class="admin-table"><thead><tr><th>ID</th><th>Title</th><th>Category</th><th>Price</th><th>Rating</th><th>Badge</th></tr></thead><tbody>'+
products.map(p=>\`<tr><td>\${p.id}</td><td>\${p.title}</td><td>\${p.category}</td><td>$\${p.price.toFixed(2)}</td><td>\${p.rating} (\${p.ratingCount})</td><td>\${p.badge||'-'}</td></tr>\`).join('')+'</tbody></table>';}
async function loadReviews(){const r=await fetch(API+'/api/admin/products');const products=await r.json();const el=document.getElementById('admin-content');
let html='<table class="admin-table"><thead><tr><th>Product</th><th>Rating</th><th>Comment</th><th>Date</th></tr></thead><tbody>';
for(const p of products){try{const rr=await fetch(API+'/api/reviews/'+p.id);const reviews=await rr.json();reviews.forEach(rv=>{html+=\`<tr><td>\${p.title.substring(0,40)}</td><td>\${'★'.repeat(rv.rating)}</td><td>\${rv.comment||'-'}</td><td>\${rv.createdAt||''}</td></tr>\`})}catch{}}
html+='</tbody></table>';el.innerHTML=html;}
document.querySelectorAll('.admin-sidebar a').forEach(a=>{a.addEventListener('click',e=>{e.preventDefault();document.querySelectorAll('.admin-sidebar a').forEach(x=>x.classList.remove('active'));a.classList.add('active');
const tab=a.dataset.tab;if(tab==='orders')loadOrders();else if(tab==='products')loadProducts();else if(tab==='reviews')loadReviews();})});
loadStats();loadOrders();
</script>
</body>
</html>"""


@app.route("/admin")
def admin_page():
    return _ADMIN_HTML


# ---------------------------------------------------------------------------
# Chatbot API
# ---------------------------------------------------------------------------

import re
import random

FAQ = {
    "shipping": "We offer free standard shipping on orders over $49. Standard delivery takes 5-8 business days, expedited (2-3 days) is $9.99, and next-day delivery is $14.99.",
    "return": "You can return most items within 30 days of delivery for a full refund. Items must be in original condition. Start a return from your Orders page or contact customer service.",
    "payment": "We accept Visa, Mastercard, American Express, PayPal, and Cash on Delivery (COD). All payments are processed securely.",
    "order": "Track your order from the Returns & Orders section. You'll receive email updates at every step. Most orders ship within 24 hours.",
    "warranty": "All electronics come with a 1-year manufacturer warranty. Kitchen appliances have a 2-year warranty. Extended warranty plans are available at checkout.",
    "account": "Create an account by clicking 'Hello, Sign in' at the top. You can manage your orders, wishlist, and payment methods from your account dashboard."
}

PRODUCT_CATEGORIES = {
    "electronics": "We have top electronics: iPhone 15 Pro Max ($1199), Sony WH-1000XM5 headphones ($328), Samsung 65\" OLED TV ($1797.99), and MacBook Pro 14\" ($1999).",
    "fashion": "Our fashion collection includes Levi's 501 jeans ($49.50), Nike Air Max 270 ($150), and North Face Thermoball jackets ($179).",
    "watches": "Our watch collection: Fossil Grant Chronograph ($179), Tissot PRX Powermatic 80 ($695), Citizen Eco-Drive Promaster ($395), and the iconic Rolex Submariner ($9750).",
    "home": "For home & kitchen: Instant Pot Duo ($79.95), Dyson V15 Detect ($649.99), and KitchenAid Artisan Mixer ($379.99).",
    "books": "Bestselling books: Atomic Habits by James Clear ($14.99) and The Psychology of Money ($13.79)."
}

INTENTS = [
    (r"(?i)\b(hello|hi|hey|howdy)\b", lambda _: "Hello! Welcome to Amazon Clone. How can I help you today? You can ask me about products, shipping, returns, or just browse the store!"),
    (r"(?i)\b(help|what can you do)\b", lambda _: "I can help you with:\n• Finding products - ask about any category\n• Order info - track, shipping, returns\n• Payment methods\n• Product recommendations\nJust ask me anything!"),
    (r"(?i)\b(shipping|delivery|ship|deliver|free shipping)\b", lambda _: FAQ["shipping"]),
    (r"(?i)\b(return|refund|exchange|replace)\b", lambda _: FAQ["return"]),
    (r"(?i)\b(pay|payment|credit card|debit card|cash on delivery|up|visa|mastercard|paypal|cod)\b", lambda _: FAQ["payment"]),
    (r"(?i)\b(track|order status|where is my order|shipping status)\b", lambda _: FAQ["order"]),
    (r"(?i)\b(warranty|guarantee)\b", lambda _: FAQ["warranty"]),
    (r"(?i)\b(account|sign in|login|register|create account)\b", lambda _: FAQ["account"]),
    (r"(?i)\b(electronics|phone|iphone|laptop|macbook|tv|headphone|gadget|computer)\b", lambda _: PRODUCT_CATEGORIES["electronics"] + " Would you like me to recommend one?"),
    (r"(?i)\b(fashion|clothes|jeans|shoes|nike|levi|jacket|north face)\b", lambda _: PRODUCT_CATEGORIES["fashion"] + " Interested in any of these?"),
    (r"(?i)\b(home|kitchen|mixer|vacuum|instant pot|dyson|cooker|kitchenaid)\b", lambda _: PRODUCT_CATEGORIES["home"] + " Would you like more details on any product?"),
    (r"(?i)\b(book|atomic habits|psychology of money|read|bestseller)\b", lambda _: PRODUCT_CATEGORIES["books"]),
    (r"(?i)\b(deals|discount|sale|offer|promo|coupon)\b", lambda _: "Check out our Today's Deals section on the homepage! We have discounts on electronics, fashion, home goods, and more. Also check the Deal of the Day banner for extra savings."),
    (r"(?i)\b(cart|checkout|buy|purchase|order)\b", lambda _: "To buy something, click 'Add to Cart' on any product, then proceed to checkout. You can review your cart by clicking the cart icon at the top right."),
    (r"(?i)\b(thank|thanks|appreciate)\b", lambda _: "You're welcome! Happy shopping! 🎉 Is there anything else I can help you with?"),
    (r"(?i)\b(best.?seller|popular|top rated|recommend)\b", lambda _: "Our bestsellers right now: iPhone 15 Pro Max ⭐4.8, KitchenAid Mixer ⭐4.9, and Atomic Habits ⭐4.8. What kind of product are you looking for?"),
    (r"(?i)\b(price|cost|how much)\b", lambda _: "Prices range from $13.79 for books to $1999 for the MacBook Pro. You can sort products by price using the dropdown on the products page. Tap any product for full details."),
    (r"(?i)\b(review|rating|star)\b", lambda _: "All our products have customer ratings. Top-rated: KitchenAid Mixer (⭐4.9), MacBook Pro (⭐4.9), and iPhone 15 Pro Max (⭐4.8). You can read and write reviews by opening any product's quick view."),
    (r"(?i)\b(wishlist|save|favorite|heart)\b", lambda _: "Click the heart icon on any product to add it to your wishlist. View your wishlist by clicking the heart icon in the top navigation bar."),
    (r"(?i)\b(contact|customer service|support|agent|human)\b", lambda _: "You can reach customer service at support@amazon-clone.com or call 1-800-AMAZON. Our team is available 24/7."),
]


@app.route("/api/chat", methods=["POST"])
def chat():
    data = request.get_json(silent=True)
    if not data or "message" not in data:
        return jsonify({"response": "Please send a message."}), 400
    msg = data["message"].strip()
    if not msg:
        return jsonify({"response": "Please type a question!"})

    # Check for product-specific queries
    db = get_db()
    products = db.execute("SELECT id, title, price, category FROM products").fetchall()
    product_hits = [p for p in products if any(word in msg.lower() for word in p["title"].lower().split())]
    
    if product_hits:
        hits = product_hits[:3]
        lines = []
        for p in hits:
            pid = str(p["id"])
            title = p["title"]
            price = p["price"]
            lines.append(f'<a href="#" onclick="openQuickView({pid});event.preventDefault()">{title}</a> — ${price:.2f}')
        response = "I found these products for you:<br>" + "<br>".join(lines)
        return jsonify({"response": response})

    # Check intents
    for pattern, handler in INTENTS:
        if re.search(pattern, msg):
            response = handler(None)
            return jsonify({"response": response})

    # Fallback - search products more broadly
    words = msg.lower().split()
    matches = [p for p in products if any(w in p["title"].lower() for w in words)]
    if matches:
        hits = matches[:3]
        lines = []
        for p in hits:
            pid = str(p["id"])
            title = p["title"]
            price = p["price"]
            lines.append(f'<a href="#" onclick="openQuickView({pid});event.preventDefault()">{title}</a> — ${price:.2f}')
        response = "Here are some products you might be interested in:<br>" + "<br>".join(lines)
    elif any(w in msg.lower() for w in ["what", "which", "tell", "show", "find", "search", "looking for", "recommend"]):
        response = "I can help you find products! Try asking about a category (electronics, fashion, watches, home, books) or a specific product name. What are you looking for?"
    else:
        fallbacks = [
            "That's an interesting question! I can help with product searches, shipping info, returns, and more. Try asking 'What electronics do you have?' or 'What's your return policy?'",
            "I'm not sure I understood that. Try asking about a specific product, category, or check our FAQ on shipping, returns, or payments!",
            "Hmm, I don't have a great answer for that. Here are some things I can help with:\n• 'Show me electronics'\n• 'What's the return policy?'\n• 'Recommend a bestseller'\n• 'How much is the KitchenAid mixer?'"
        ]
        response = random.choice(fallbacks)

    return jsonify({"response": response})


# ---------------------------------------------------------------------------
# Serve frontend (index.html, app.js, style.css)
# ---------------------------------------------------------------------------

FRONTEND_DIR = os.path.dirname(os.path.abspath(__file__))


@app.route("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.route("/<path:filename>")
def frontend_files(filename):
    if filename.endswith(".py") or filename.startswith(".") or filename.startswith("venv/"):
        return jsonify({"error": "Forbidden"}), 403
    return send_from_directory(FRONTEND_DIR, filename)


# ---------------------------------------------------------------------------
# App entry
# ---------------------------------------------------------------------------

app.teardown_appcontext(close_db)

# Initialize database on import (for gunicorn/production)
init_db()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    print(f"Backend starting on http://0.0.0.0:{port}")
    app.run(host="0.0.0.0", port=port, debug=True)
