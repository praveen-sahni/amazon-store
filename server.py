"""
Amazon Clone — Python Flask Backend
Provides REST API for products, cart, checkout, reviews, wishlist, and admin.
"""

import hashlib
import json
import os
import re
import random
import smtplib
import sqlite3
import uuid
from datetime import datetime, timezone
from email.mime.text import MIMEText

from flask import Flask, g, jsonify, request, send_from_directory, session
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__, static_folder=None)
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "amazon-clone-dev-secret-key-change-in-production")

@app.after_request
def add_security_headers(response):
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['X-XSS-Protection'] = '1; mode=block'
    response.headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'
    csp = "default-src 'self' 'unsafe-inline' 'unsafe-eval' https: data: blob:; img-src 'self' https: data: blob:; font-src 'self' https: data:; connect-src 'self' https: ws:;"
    response.headers['Content-Security-Policy'] = csp
    return response

# Rate limiting
app.config["RATELIMIT_ENABLED"] = os.environ.get("RATELIMIT_ENABLED", "true").lower() == "true"
app.config["RATELIMIT_DEFAULT"] = os.environ.get("RATELIMIT_DEFAULT", "200 per minute")

try:
    from flask_limiter import Limiter
    from flask_limiter.util import get_remote_address
    limiter = Limiter(
        app=app,
        key_func=get_remote_address,
        default_limits=[app.config["RATELIMIT_DEFAULT"]],
        enabled=app.config["RATELIMIT_ENABLED"],
    )
except ImportError:
    limiter = None

# CSRF protection for state-changing requests
CSRF_ENABLED = os.environ.get("CSRF_ENABLED", "true").lower() == "true"

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


def send_order_confirmation_email(order_id, email, customer_name, items, total, tracking_code):
    """Send order confirmation. In dev mode, logs to console."""
    subject = f"Order Confirmed - {order_id}"
    items_html = "".join(
        f"<tr><td>{i['title']}</td><td>{i['quantity']}</td><td>${i['price']:.2f}</td><td>${i['price']*i['quantity']:.2f}</td></tr>"
        for i in items
    )
    body = f"""
    <h2>Thank you for your order, {customer_name}!</h2>
    <p>Order <strong>{order_id}</strong> has been confirmed.</p>
    <p>Tracking: <strong>{tracking_code}</strong></p>
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%">
    <tr><th>Item</th><th>Qty</th><th>Price</th><th>Total</th></tr>
    {items_html}
    <tr><td colspan="3"><strong>Total</strong></td><td><strong>${total:.2f}</strong></td></tr>
    </table>
    """
    print(f"\n{'='*60}")
    print(f"EMAIL to {email}: Order Confirmation - {order_id}")
    print(f"{'='*60}")
    print(f"Subject: {subject}")
    print(f"Body: {body[:500]}...")
    print(f"{'='*60}\n")
    # Production: uncomment below with real SMTP settings
    # try:
    #     msg = MIMEText(body, 'html')
    #     msg['Subject'] = subject
    #     msg['To'] = email
    #     msg['From'] = os.environ.get('SMTP_FROM', 'noreply@amazon-store.com')
    #     with smtplib.SMTP(os.environ.get('SMTP_HOST', ''), int(os.environ.get('SMTP_PORT', 587))) as s:
    #         s.starttls()
    #         s.login(os.environ.get('SMTP_USER', ''), os.environ.get('SMTP_PASS', ''))
    #         s.send_message(msg)
    # except Exception as e:
    #     print(f"Failed to send email: {e}")


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

        CREATE TABLE IF NOT EXISTS users (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT    NOT NULL,
            email       TEXT    NOT NULL UNIQUE,
            password    TEXT    NOT NULL,
            created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS coupons (
            code            TEXT PRIMARY KEY,
            discount_type   TEXT NOT NULL CHECK(discount_type IN ('percent','fixed')),
            discount_value  REAL NOT NULL,
            min_cart_value  REAL NOT NULL DEFAULT 0,
            usage_limit     INTEGER NOT NULL DEFAULT 100,
            times_used      INTEGER NOT NULL DEFAULT 0,
            expires_at      TEXT,
            created_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS price_history (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
            price       REAL NOT NULL,
            recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS wishlist_shares (
            token       TEXT PRIMARY KEY,
            session_id  TEXT NOT NULL,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS flash_sales (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
            sale_price  REAL NOT NULL,
            ends_at     TEXT NOT NULL,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS product_qa (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
            session_id  TEXT NOT NULL,
            author_name TEXT NOT NULL DEFAULT 'Anonymous',
            question    TEXT NOT NULL,
            answer      TEXT DEFAULT '',
            answered_at TEXT,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS gift_cards (
            code        TEXT PRIMARY KEY,
            amount      REAL NOT NULL,
            redeemed    INTEGER NOT NULL DEFAULT 0,
            session_id  TEXT NOT NULL,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS user_sessions (
            session_id TEXT PRIMARY KEY,
            user_id INTEGER REFERENCES users(id),
            created_at TEXT DEFAULT (datetime('now'))
        );

    """)
    # Add status column if not present
    try:
        db.execute("ALTER TABLE customer_orders ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'")
    except sqlite3.OperationalError:
        pass
    # Add tracking_code column if not present
    try:
        db.execute("ALTER TABLE customer_orders ADD COLUMN tracking_code TEXT DEFAULT ''")
    except sqlite3.OperationalError:
        pass
    # Add tracking_updates column if not present
    try:
        db.execute("ALTER TABLE customer_orders ADD COLUMN tracking_updates TEXT DEFAULT '[]'")
    except sqlite3.OperationalError:
        pass
    try:
        db.execute("ALTER TABLE products ADD COLUMN stock INTEGER NOT NULL DEFAULT 50")
    except sqlite3.OperationalError:
        pass
    try:
        db.execute("ALTER TABLE products ADD COLUMN images TEXT DEFAULT ''")
    except sqlite3.OperationalError:
        pass
    try:
        db.execute("ALTER TABLE products ADD COLUMN variants TEXT DEFAULT ''")
    except sqlite3.OperationalError:
        pass
    try:
        db.execute("ALTER TABLE users ADD COLUMN password_hash TEXT DEFAULT ''")
    except sqlite3.OperationalError:
        pass
    # Seed flash sales
    fs_count = db.execute("SELECT COUNT(*) FROM flash_sales").fetchone()[0]
    if fs_count == 0:
        fs_rows = db.execute("SELECT id, price FROM products ORDER BY RANDOM() LIMIT 4").fetchall()
        from datetime import datetime, timedelta, timezone
        now = datetime.now(timezone.utc)
        for fp in fs_rows:
            sale_price = round(fp[1] * 0.7, 2)  # fp[0]=id, fp[1]=price
            ends_at = (now + timedelta(hours=random.randint(4, 48))).strftime("%Y-%m-%d %H:%M:%S")
            db.execute("INSERT INTO flash_sales (product_id, sale_price, ends_at) VALUES (?, ?, ?)",
                       (fp[0], sale_price, ends_at))
        db.commit()
    # Seed coupons
    coupon_count = db.execute("SELECT COUNT(*) FROM coupons").fetchone()[0]
    if coupon_count == 0:
        coupons = [
            ("WELCOME10", "percent", 10, 20, 100, "2027-12-31"),
            ("SAVE50", "fixed", 50, 100, 50, "2027-12-31"),
            ("SUMMER20", "percent", 20, 50, 200, "2026-09-30"),
            ("FREESHIP", "fixed", 15, 30, 500, "2026-12-31"),
        ]
        for c in coupons:
            db.execute(
                "INSERT INTO coupons (code, discount_type, discount_value, min_cart_value, usage_limit, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
                c,
            )
        db.commit()
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
# CSRF / Security helpers
# ---------------------------------------------------------------------------

def require_csrf():
    """Simple CSRF check: require X-Requested-With header or skip for GET/HEAD/OPTIONS."""
    if not CSRF_ENABLED:
        return
    if request.method in ("GET", "HEAD", "OPTIONS"):
        return
    if request.headers.get("X-Requested-With") == "XMLHttpRequest":
        return
    # Allow same-origin (no Origin header or same origin)
    origin = request.headers.get("Origin", "")
    if not origin or origin == request.host_url.rstrip("/"):
        return
    # Also allow requests with no Referer
    referer = request.headers.get("Referer", "")
    if not referer:
        return
    # Check referer matches host
    if request.host_url.rstrip("/") in referer:
        return
    return jsonify({"error": "CSRF check failed"}), 403


@app.before_request
def before_request():
    resp = require_csrf()
    if resp:
        return resp


# ---------------------------------------------------------------------------
# Health endpoint
# ---------------------------------------------------------------------------


@app.route("/api/health")
def health():
    return jsonify({"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()})


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

@app.route("/api/signup", methods=["POST"])
@limiter.limit("10 per minute") if limiter else lambda f: f
def signup():
    data = request.get_json()
    name = (data.get("name") or "").strip()
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""

    if not name or not email or not password:
        return jsonify({"error": "Name, email, and password are required"}), 400
    if len(password) < 4:
        return jsonify({"error": "Password must be at least 4 characters"}), 400

    db = get_db()
    existing = db.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
    if existing:
        return jsonify({"error": "An account with this email already exists"}), 409

    pw_hash = hashlib.sha256(password.encode()).hexdigest()
    cur = db.execute("INSERT INTO users (name, email, password) VALUES (?, ?, ?)", (name, email, pw_hash))
    db.commit()

    session["user_id"] = cur.lastrowid
    session["user_name"] = name
    session["user_email"] = email
    return jsonify({"user": {"id": cur.lastrowid, "name": name, "email": email}})


@app.route("/api/login", methods=["POST"])
@limiter.limit("20 per minute") if limiter else lambda f: f
def login():
    data = request.get_json()
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""

    if not email or not password:
        return jsonify({"error": "Email and password are required"}), 400

    db = get_db()
    pw_hash = hashlib.sha256(password.encode()).hexdigest()
    user = db.execute("SELECT id, name, email FROM users WHERE email = ? AND password = ?", (email, pw_hash)).fetchone()
    if not user:
        return jsonify({"error": "Invalid email or password"}), 401

    session["user_id"] = user["id"]
    session["user_name"] = user["name"]
    session["user_email"] = user["email"]
    return jsonify({"user": {"id": user["id"], "name": user["name"], "email": user["email"]}})


@app.route("/api/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"ok": True})


@app.route("/api/user", methods=["GET"])
def get_user():
    if "user_id" not in session:
        return jsonify({"user": None})
    return jsonify({"user": {"id": session["user_id"], "name": session["user_name"], "email": session["user_email"]}})


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
        "stock": row["stock"],
        "images": json.loads(row["images"]) if row["images"] else [],
        "variants": json.loads(row["variants"]) if row["variants"] else [],
    }


# ---------------------------------------------------------------------------
# Routes — Products
# ---------------------------------------------------------------------------

@app.route("/api/products", methods=["GET"])
def list_products():
    db = get_db()
    page = request.args.get("page", 1, type=int)
    per_page = request.args.get("per_page", 100, type=int)
    per_page = min(per_page, 100)
    offset = (page - 1) * per_page
    rows = db.execute("SELECT * FROM products ORDER BY id LIMIT ? OFFSET ?", (per_page, offset)).fetchall()
    total = db.execute("SELECT COUNT(*) FROM products").fetchone()[0]
    return jsonify({
        "products": [row_to_product(r) for r in rows],
        "total": total,
        "page": page,
        "per_page": per_page,
        "total_pages": (total + per_page - 1) // per_page,
    })


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
    # Check for active flash sales first
    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    flash = db.execute(
        "SELECT fs.*, p.* FROM flash_sales fs JOIN products p ON p.id = fs.product_id "
        "WHERE fs.ends_at > ? ORDER BY fs.ends_at ASC LIMIT 1",
        (now_str,),
    ).fetchone()
    if flash:
        product = dict(flash)
        product["sale_price"] = flash["sale_price"]
        product["ends_at"] = flash["ends_at"]
        product["badge"] = "flash-sale"
        return jsonify({**row_to_product(flash), "flashSale": {"salePrice": flash["sale_price"], "endsAt": flash["ends_at"]}})
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
@limiter.limit("10 per minute") if limiter else lambda f: f
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

        # Check stock
        stock_row = db.execute("SELECT stock FROM products WHERE id = ?", (pid,)).fetchone()
        avail = stock_row["stock"] if stock_row else 0
        if qty > avail:
            return jsonify({"error": f"Insufficient stock for {title}. Available: {avail}"}), 400

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

    # Apply coupon discount if provided
    coupon_code = body.get("couponCode", "").strip().upper()
    discount_amount = 0.0
    if coupon_code:
        coupon = db.execute("SELECT * FROM coupons WHERE code = ?", (coupon_code,)).fetchone()
        if coupon and coupon["times_used"] < coupon["usage_limit"]:
            if total >= coupon["min_cart_value"]:
                if coupon["discount_type"] == "percent":
                    discount_amount = round(total * coupon["discount_value"] / 100, 2)
                else:
                    discount_amount = min(coupon["discount_value"], total)
                total = round(total - discount_amount, 2)
                db.execute("UPDATE coupons SET times_used = times_used + 1 WHERE code = ?", (coupon_code,))

    # Apply gift card
    gift_card_code = body.get("giftCardCode", "").strip().upper()
    gift_discount = 0.0
    if gift_card_code:
        gc = db.execute("SELECT * FROM gift_cards WHERE code = ? AND redeemed = 0", (gift_card_code,)).fetchone()
        if gc:
            gift_discount = min(gc["amount"], total)
            total = round(total - gift_discount, 2)
            db.execute("UPDATE gift_cards SET redeemed = 1 WHERE code = ?", (gift_card_code,))

    order_id = f"ORD-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid.uuid4().hex[:6].upper()}"
    tracking_code = f"TRK-{uuid.uuid4().hex[:8].upper()}"
    tracking_updates = [
        {"status": "confirmed", "date": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"), "message": "Order confirmed"}
    ]

    db.execute(
        "INSERT INTO customer_orders (order_id, session_id, customer_name, email, address, payment_method, total, item_count, tracking_code, tracking_updates) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            order_id,
            session_id,
            body.get("customerName", ""),
            body.get("email", ""),
            body.get("address", ""),
            body.get("paymentMethod", "card"),
            round(total, 2),
            len(resolved_items),
            tracking_code,
            json.dumps(tracking_updates),
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
        # Record price history for each purchased product
        db.execute(
            "INSERT INTO price_history (product_id, price) VALUES (?, ?)",
            (ri["product_id"], ri["price"]),
        )
        # Decrement stock
        db.execute("UPDATE products SET stock = MAX(0, stock - ?) WHERE id = ?",
                   (ri["quantity"], ri["product_id"]))

    db.commit()

    # Send confirmation email
    send_order_confirmation_email(
        order_id,
        body.get("email", ""),
        body.get("customerName", ""),
        resolved_items,
        total,
        tracking_code
    )

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
            "trackingCode": tracking_code,
            "couponDiscount": discount_amount,
            "giftCardDiscount": gift_discount,
        }
    )


# ---------------------------------------------------------------------------
# Routes — Orders
# ---------------------------------------------------------------------------

@app.route("/api/orders", methods=["GET"])
def list_orders():
    db = get_db()
    session_id = request.args.get("session_id")
    if session_id:
        rows = db.execute(
            "SELECT * FROM customer_orders WHERE session_id = ? ORDER BY created_at DESC",
            (session_id,),
        ).fetchall()
    else:
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
                "status": r["status"],
                "trackingCode": r["tracking_code"] or "",
                "trackingUpdates": json.loads(r["tracking_updates"]) if r["tracking_updates"] else [],
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
            "status": row["status"],
            "trackingCode": row["tracking_code"] or "",
            "trackingUpdates": json.loads(row["tracking_updates"]) if row["tracking_updates"] else [],
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

# ---------------------------------------------------------------------------
# Routes — Coupons
# ---------------------------------------------------------------------------

@app.route("/api/coupons/validate", methods=["POST"])
def validate_coupon():
    body = request.get_json(silent=True) or {}
    code = body.get("code", "").strip().upper()
    cart_total = body.get("cartTotal", 0)
    if not code:
        return jsonify({"valid": False, "error": "Please enter a coupon code"})
    db = get_db()
    coupon = db.execute("SELECT * FROM coupons WHERE code = ?", (code,)).fetchone()
    if not coupon:
        return jsonify({"valid": False, "error": "Invalid coupon code"})
    if coupon["times_used"] >= coupon["usage_limit"]:
        return jsonify({"valid": False, "error": "This coupon has expired"})
    if coupon["expires_at"] and coupon["expires_at"] < datetime.now(timezone.utc).strftime("%Y-%m-%d"):
        return jsonify({"valid": False, "error": "This coupon has expired"})
    if cart_total < coupon["min_cart_value"]:
        return jsonify({"valid": False, "error": f"Minimum cart value of ${coupon['min_cart_value']:.2f} required"})
    if coupon["discount_type"] == "percent":
        discount = round(cart_total * coupon["discount_value"] / 100, 2)
        desc = f"{coupon['discount_value']:.0f}% off"
    else:
        discount = min(coupon["discount_value"], cart_total)
        desc = f"${coupon['discount_value']:.0f} off"
    return jsonify({"valid": True, "code": coupon["code"], "discount": discount, "description": desc})


# ---------------------------------------------------------------------------
# Routes — Price History
# ---------------------------------------------------------------------------

@app.route("/api/products/<int:product_id>/price-history", methods=["GET"])
def price_history(product_id):
    db = get_db()
    rows = db.execute(
        "SELECT price, recorded_at FROM price_history WHERE product_id = ? ORDER BY recorded_at ASC",
        (product_id,),
    ).fetchall()
    # Also include current price
    product = db.execute("SELECT price FROM products WHERE id = ?", (product_id,)).fetchone()
    current_price = product["price"] if product else 0
    return jsonify({
        "currentPrice": current_price,
        "history": [{"price": r["price"], "date": r["recorded_at"]} for r in rows],
    })


@app.route("/api/products/<int:product_id>/record-price", methods=["POST"])
def record_price(product_id):
    db = get_db()
    product = db.execute("SELECT price FROM products WHERE id = ?", (product_id,)).fetchone()
    if not product:
        return jsonify({"error": "Not found"}), 404
    db.execute("INSERT INTO price_history (product_id, price) VALUES (?, ?)", (product_id, product["price"]))
    db.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Routes — Recommendations (Customers Also Bought)
# ---------------------------------------------------------------------------

@app.route("/api/products/<int:product_id>/also-bought", methods=["GET"])
def also_bought(product_id):
    db = get_db()
    # Find orders containing this product
    order_ids = db.execute(
        "SELECT DISTINCT oi.order_id FROM order_items oi WHERE oi.product_id = ?", (product_id,)
    ).fetchall()
    if not order_ids:
        return jsonify([])
    ids = [r["order_id"] for r in order_ids]
    placeholders = ",".join("?" for _ in ids)
    # Find other products in those orders
    rows = db.execute(
        f"SELECT p.*, COUNT(*) as bought_together FROM order_items oi "
        f"JOIN products p ON p.id = oi.product_id "
        f"WHERE oi.order_id IN ({placeholders}) AND oi.product_id != ? "
        f"GROUP BY oi.product_id ORDER BY bought_together DESC LIMIT 6",
        (*ids, product_id),
    ).fetchall()
    return jsonify([row_to_product(r) for r in rows])


# ---------------------------------------------------------------------------
# Routes — Wishlist Sharing
# ---------------------------------------------------------------------------

@app.route("/api/wishlist/<session_id>/share", methods=["GET"])
def wishlist_share_generate(session_id):
    db = get_db()
    token = uuid.uuid4().hex[:12]
    db.execute("INSERT INTO wishlist_shares (token, session_id) VALUES (?, ?)", (token, session_id))
    db.commit()
    return jsonify({"token": token, "url": f"/shared/wishlist/{token}"})


@app.route("/api/wishlist/share/<token>", methods=["GET"])
def wishlist_share_view(token):
    db = get_db()
    share = db.execute("SELECT * FROM wishlist_shares WHERE token = ?", (token,)).fetchone()
    if not share:
        return jsonify({"error": "Shared wishlist not found"}), 404
    rows = db.execute(
        """SELECT p.* FROM wishlists w
           JOIN products p ON p.id = w.product_id
           WHERE w.session_id = ?
           ORDER BY w.added_at DESC""",
        (share["session_id"],),
    ).fetchall()
    return jsonify({"sessionId": share["session_id"], "products": [row_to_product(r) for r in rows]})


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
# Routes — Flash Sales
# ---------------------------------------------------------------------------

@app.route("/api/flash-sales", methods=["GET"])
def list_flash_sales():
    db = get_db()
    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    rows = db.execute(
        "SELECT fs.*, p.* FROM flash_sales fs JOIN products p ON p.id = fs.product_id "
        "WHERE fs.ends_at > ? ORDER BY fs.ends_at ASC", (now_str,)
    ).fetchall()
    result = []
    for r in rows:
        p = row_to_product(r)
        p["flashSale"] = {"salePrice": r["sale_price"], "endsAt": r["ends_at"]}
        result.append(p)
    return jsonify(result)


# ---------------------------------------------------------------------------
# Routes — Product Q&A
# ---------------------------------------------------------------------------

@app.route("/api/products/<int:product_id>/qa", methods=["GET"])
def list_qa(product_id):
    db = get_db()
    rows = db.execute(
        "SELECT * FROM product_qa WHERE product_id = ? ORDER BY created_at DESC", (product_id,)
    ).fetchall()
    return jsonify([
        {
            "id": r["id"],
            "authorName": r["author_name"],
            "question": r["question"],
            "answer": r["answer"],
            "createdAt": r["created_at"],
            "answeredAt": r["answered_at"],
        }
        for r in rows
    ])


@app.route("/api/products/<int:product_id>/qa", methods=["POST"])
def add_qa(product_id):
    db = get_db()
    body = request.get_json(silent=True) or {}
    question = (body.get("question") or "").strip()
    if not question:
        return jsonify({"error": "Question is required"}), 400
    author = (body.get("authorName") or "Anonymous").strip()
    session_id = body.get("session_id", "anonymous")
    db.execute(
        "INSERT INTO product_qa (product_id, session_id, author_name, question) VALUES (?, ?, ?, ?)",
        (product_id, session_id, author, question),
    )
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/products/<int:product_id>/qa/<int:qa_id>/answer", methods=["POST"])
def answer_qa(product_id, qa_id):
    db = get_db()
    body = request.get_json(silent=True) or {}
    answer = (body.get("answer") or "").strip()
    if not answer:
        return jsonify({"error": "Answer is required"}), 400
    db.execute(
        "UPDATE product_qa SET answer = ?, answered_at = datetime('now') WHERE id = ? AND product_id = ?",
        (answer, qa_id, product_id),
    )
    db.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Routes — Gift Cards
# ---------------------------------------------------------------------------

@app.route("/api/gift-cards/purchase", methods=["POST"])
def purchase_gift_card():
    db = get_db()
    body = request.get_json(silent=True) or {}
    amount = float(body.get("amount", 0))
    if amount < 5:
        return jsonify({"error": "Minimum gift card amount is $5"}), 400
    session_id = body.get("session_id", "anonymous")
    code = f"GIFT-{uuid.uuid4().hex[:8].upper()}"
    db.execute(
        "INSERT INTO gift_cards (code, amount, session_id) VALUES (?, ?, ?)",
        (code, amount, session_id),
    )
    db.commit()
    return jsonify({"code": code, "amount": amount})


@app.route("/api/gift-cards/validate", methods=["POST"])
def validate_gift_card():
    db = get_db()
    body = request.get_json(silent=True) or {}
    code = (body.get("code") or "").strip().upper()
    gc = db.execute("SELECT * FROM gift_cards WHERE code = ? AND redeemed = 0", (code,)).fetchone()
    if not gc:
        return jsonify({"valid": False, "error": "Invalid or already redeemed gift card"})
    return jsonify({"valid": True, "amount": gc["amount"], "code": gc["code"]})


@app.route("/api/create-payment-intent", methods=["POST"])
@limiter.limit("30 per minute") if limiter else lambda f: f
def create_payment_intent():
    data = request.get_json(silent=True) or {}
    amount = int(float(data.get("amount", 0)) * 100)  # cents
    if amount <= 0:
        return jsonify({"error": "Invalid amount"}), 400
    # Mock payment intent — replace with Stripe in production
    return jsonify({
        "clientSecret": f"pi_mock_{uuid.uuid4().hex}",
        "amount": amount,
        "currency": "usd",
        "status": "requires_payment_method"
    })


@app.route("/api/profile", methods=["GET"])
def get_profile():
    user_id = session.get("user_id")
    if not user_id:
        return jsonify({"error": "Not authenticated"}), 401
    db = get_db()
    row = db.execute("SELECT id, name, email, created_at FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row:
        return jsonify({"error": "User not found"}), 404
    order_count = db.execute("SELECT COUNT(*) as cnt FROM customer_orders WHERE session_id IN (SELECT session_id FROM user_sessions WHERE user_id = ?)", (user_id,)).fetchone()["cnt"]
    return jsonify({
        "id": row["id"], "name": row["name"], "email": row["email"],
        "createdAt": row["created_at"], "orderCount": order_count
    })

@app.route("/api/profile", methods=["PUT"])
def update_profile():
    user_id = session.get("user_id")
    if not user_id:
        return jsonify({"error": "Not authenticated"}), 401
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Name is required"}), 400
    db = get_db()
    db.execute("UPDATE users SET name = ? WHERE id = ?", (name, user_id))
    db.commit()
    return jsonify({"ok": True, "name": name})

@app.route("/api/profile/password", methods=["POST"])
def change_password():
    user_id = session.get("user_id")
    if not user_id:
        return jsonify({"error": "Not authenticated"}), 401
    data = request.get_json(silent=True) or {}
    current = data.get("currentPassword", "")
    new_pass = data.get("newPassword", "")
    if not current or not new_pass:
        return jsonify({"error": "Current and new password required"}), 400
    if len(new_pass) < 6:
        return jsonify({"error": "New password must be at least 6 characters"}), 400
    db = get_db()
    row = db.execute("SELECT password_hash FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row or row["password_hash"] != hashlib.sha256(current.encode()).hexdigest():
        return jsonify({"error": "Current password is incorrect"}), 403
    db.execute("UPDATE users SET password_hash = ? WHERE id = ?", (hashlib.sha256(new_pass.encode()).hexdigest(), user_id))
    db.commit()
    return jsonify({"ok": True, "message": "Password changed successfully"})


# ---------------------------------------------------------------------------
# Routes — Invoice Download
# ---------------------------------------------------------------------------

@app.route("/api/orders/<order_id>/invoice", methods=["GET"])
def order_invoice(order_id):
    db = get_db()
    row = db.execute("SELECT * FROM customer_orders WHERE order_id = ?", (order_id,)).fetchone()
    if not row:
        return jsonify({"error": "Not found"}), 404
    items = db.execute("SELECT * FROM order_items WHERE order_id = ?", (order_id,)).fetchall()
    invoice_html = f"""<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
body {{ font-family: Arial, sans-serif; margin: 40px; color: #333; }}
.invoice-header {{ text-align: center; margin-bottom: 30px; border-bottom: 2px solid #f08804; padding-bottom: 15px; }}
.invoice-header h1 {{ color: #131921; margin: 0; }}
.invoice-header p {{ color: #666; margin: 5px 0; }}
.invoice-details {{ margin-bottom: 20px; }}
.invoice-details table {{ width: 100%; }}
.invoice-details td {{ padding: 4px 0; }}
.items-table {{ width: 100%; border-collapse: collapse; margin: 20px 0; }}
.items-table th {{ background: #f3a847; color: #fff; padding: 10px; text-align: left; }}
.items-table td {{ padding: 10px; border-bottom: 1px solid #ddd; }}
.total-row td {{ font-weight: bold; font-size: 16px; }}
.grand-total {{ font-size: 18px; color: #b12704; }}
.footer {{ text-align: center; margin-top: 40px; color: #999; font-size: 12px; border-top: 1px solid #ddd; padding-top: 15px; }}
</style></head><body>
<div class="invoice-header"><h1>INVOICE</h1><p>Order #{row['order_id']}</p><p>{row['created_at']}</p></div>
<div class="invoice-details"><table>
<tr><td><strong>Customer:</strong></td><td>{row['customer_name']}</td></tr>
<tr><td><strong>Email:</strong></td><td>{row['email']}</td></tr>
<tr><td><strong>Address:</strong></td><td>{row['address']}</td></tr>
<tr><td><strong>Payment:</strong></td><td>{row['payment_method']}</td></tr>
<tr><td><strong>Tracking:</strong></td><td>{row['tracking_code'] or 'N/A'}</td></tr>
</table></div>
<table class="items-table"><tr><th>Item</th><th>Price</th><th>Qty</th><th>Total</th></tr>"""
    for it in items:
        line = it["price"] * it["quantity"]
        invoice_html += f"<tr><td>{it['title']}</td><td>${it['price']:.2f}</td><td>{it['quantity']}</td><td>${line:.2f}</td></tr>"
    invoice_html += f"""</table>
<table class="items-table"><tr class="total-row"><td colspan="3">Total</td><td class="grand-total">${row['total']:.2f}</td></tr></table>
<div class="footer"><p>Thank you for shopping with us!</p><p>RTR Store</p></div>
</body></html>"""
    return Response(invoice_html, mimetype="text/html")


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
    "gym": "Gym & fitness favorites: Bowflex SelectTech 552 dumbbells ($349), Fit Simplify resistance bands ($29.95), Gaiam yoga mat ($69.98), and BlenderBottle shaker cup ($14.99).",
    "travel": "Travel essentials: Samsonite Winfield 2 carry-on ($199.99), Travelpro Maxlite 5 backpack ($89.99), Cabeau travel pillow ($39.99), and Veken packing cubes ($24.99).",
    "stationery": "Stationery favorites: Moleskine Classic Notebook ($19.99), Pilot G2 gel pen 12-pack ($14.99), Swingline stapler ($24.99), and Scotch tape dispenser 3-pack ($9.99).",
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
        response = "I can help you find products! Try asking about a category (electronics, fashion, watches, gym, travel, stationery, home, books) or a specific product name. What are you looking for?"
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
