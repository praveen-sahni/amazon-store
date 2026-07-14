"""Tests for the Amazon Clone Flask backend."""

import json
import os
import sys
import tempfile
import uuid
import pytest

sys.path.insert(0, os.path.dirname(__file__))

# Override DB path before importing app
TEST_DB = os.path.join(tempfile.gettempdir(), "amazon_test.db")
os.environ["CSRF_ENABLED"] = "false"
os.environ["RATELIMIT_ENABLED"] = "false"


@pytest.fixture(autouse=True)
def patch_db_path(monkeypatch):
    monkeypatch.setattr("server.DB_PATH", TEST_DB)
    # Re-init the DB
    from server import app, init_db
    init_db()
    yield
    # Cleanup
    try:
        os.remove(TEST_DB)
    except OSError:
        pass


@pytest.fixture
def client():
    from server import app
    app.config["TESTING"] = True
    with app.test_client() as c:
        yield c


# ---------------------------------------------------------------------------
# API Tests
# ---------------------------------------------------------------------------


def test_health(client):
    resp = client.get("/api/health")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["status"] == "ok"


def test_list_products(client):
    resp = client.get("/api/products")
    assert resp.status_code == 200
    data = resp.get_json()
    assert "products" in data
    assert "total" in data
    assert data["total"] > 0
    assert len(data["products"]) > 0


def test_list_products_pagination(client):
    resp = client.get("/api/products?page=1&per_page=5")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["per_page"] == 5
    assert data["page"] == 1
    assert len(data["products"]) <= 5


def test_get_product_by_id(client):
    resp = client.get("/api/products/1")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["id"] == 1
    assert "title" in data
    assert "price" in data


def test_get_product_not_found(client):
    resp = client.get("/api/products/99999")
    assert resp.status_code == 404


def test_products_by_category(client):
    resp = client.get("/api/products/category/electronics")
    assert resp.status_code == 200
    data = resp.get_json()
    assert len(data) > 0
    for p in data:
        assert p["category"].lower() == "electronics"


def test_deal_of_day(client):
    resp = client.get("/api/products/deal")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["badge"] == "deal"


def test_related_products(client):
    resp = client.get("/api/products/1/related")
    assert resp.status_code == 200
    data = resp.get_json()
    assert isinstance(data, list)
    # Should not include the product itself
    for p in data:
        assert p["id"] != 1


def test_cart_save_and_get(client):
    session_id = "test-session-123"
    items = [{"id": 1, "quantity": 2, "product": {"title": "Test", "price": 10.0, "image": ""}}]
    save = client.post(f"/api/cart/{session_id}", json=items)
    assert save.status_code == 200

    resp = client.get(f"/api/cart/{session_id}")
    assert resp.status_code == 200
    data = resp.get_json()
    assert len(data) == 1


def test_cart_clear(client):
    session_id = "test-session-clear"
    client.post(f"/api/cart/{session_id}", json=[{"id": 1, "quantity": 1}])
    client.delete(f"/api/cart/{session_id}")
    resp = client.get(f"/api/cart/{session_id}")
    assert resp.get_json() == []


def test_checkout(client):
    session_id = "test-checkout"
    payload = {
        "customerName": "John Doe",
        "email": "john@example.com",
        "address": "123 Main St",
        "paymentMethod": "card",
        "items": [{"id": 1, "quantity": 1, "product": {"title": "Test", "price": 25.0, "image": ""}}],
        "clearCartAfterCheckout": True,
    }
    resp = client.post(f"/api/cart/{session_id}/checkout", json=payload)
    assert resp.status_code == 200
    data = resp.get_json()
    assert "orderId" in data
    assert data["orderId"].startswith("ORD-")
    assert data["total"] == 25.0


def test_checkout_empty_cart(client):
    resp = client.post("/api/cart/test-empty/checkout", json={"items": []})
    assert resp.status_code == 400


def test_wishlist_add_and_list(client):
    session_id = "test-wl"
    add = client.post(f"/api/wishlist/{session_id}", json={"productId": 1})
    assert add.status_code == 200

    resp = client.get(f"/api/wishlist/{session_id}")
    assert resp.status_code == 200
    data = resp.get_json()
    assert len(data) == 1
    assert data[0]["id"] == 1


def test_wishlist_remove(client):
    session_id = "test-wl-remove"
    client.post(f"/api/wishlist/{session_id}", json={"productId": 1})
    client.delete(f"/api/wishlist/{session_id}/1")
    resp = client.get(f"/api/wishlist/{session_id}")
    assert resp.get_json() == []


def test_wishlist_check(client):
    session_id = "test-wl-check"
    client.post(f"/api/wishlist/{session_id}", json={"productId": 3})
    resp = client.get(f"/api/wishlist/{session_id}/check/3")
    data = resp.get_json()
    assert data["wishlisted"] is True

    resp2 = client.get(f"/api/wishlist/{session_id}/check/999")
    data2 = resp2.get_json()
    assert data2["wishlisted"] is False


def test_reviews(client):
    # Add a review
    resp = client.post("/api/reviews", json={
        "productId": 1, "sessionId": "test-reviewer", "rating": 5, "comment": "Great product!"
    })
    assert resp.status_code == 200

    # List reviews
    resp = client.get("/api/reviews/1")
    assert resp.status_code == 200
    data = resp.get_json()
    assert len(data) >= 1
    assert data[0]["rating"] == 5


def test_reviews_without_product_id(client):
    resp = client.post("/api/reviews", json={"rating": 5})
    assert resp.status_code == 400


def test_signup_and_login(client):
    # Sign up
    signup = client.post("/api/signup", json={
        "name": "Test User", "email": "test@example.com", "password": "test1234"
    })
    assert signup.status_code == 200
    data = signup.get_json()
    assert data["user"]["name"] == "Test User"

    # Login
    login = client.post("/api/login", json={
        "email": "test@example.com", "password": "test1234"
    })
    assert login.status_code == 200
    data = login.get_json()
    assert data["user"]["name"] == "Test User"

    # Get user
    user = client.get("/api/user")
    assert user.status_code == 200
    assert user.get_json()["user"]["name"] == "Test User"


def test_signup_duplicate(client):
    client.post("/api/signup", json={"name": "A", "email": "dup@example.com", "password": "1234"})
    resp = client.post("/api/signup", json={"name": "B", "email": "dup@example.com", "password": "5678"})
    assert resp.status_code == 409


def test_login_wrong_password(client):
    client.post("/api/signup", json={"name": "X", "email": "x@example.com", "password": "correct"})
    resp = client.post("/api/login", json={"email": "x@example.com", "password": "wrong"})
    assert resp.status_code == 401


def test_orders_api(client):
    # Place an order first
    client.post("/api/cart/test-orders/checkout", json={
        "customerName": "Jane", "email": "j@e.com", "address": "Addr",
        "paymentMethod": "cod",
        "items": [{"id": 1, "quantity": 1, "product": {"title": "T", "price": 10, "image": ""}}],
        "clearCartAfterCheckout": False,
    })
    resp = client.get("/api/orders")
    assert resp.status_code == 200
    orders = resp.get_json()
    assert len(orders) >= 1


def test_chatbot(client):
    resp = client.post("/api/chat", json={"message": "hello"})
    assert resp.status_code == 200
    data = resp.get_json()
    assert "response" in data

    resp2 = client.post("/api/chat", json={"message": ""})
    assert resp2.status_code == 200


def test_admin_stats(client):
    resp = client.get("/api/admin/stats")
    assert resp.status_code == 200
    data = resp.get_json()
    assert "totalProducts" in data
    assert data["totalProducts"] > 0


def test_admin_page(client):
    resp = client.get("/admin")
    assert resp.status_code == 200
    assert b"Admin Dashboard" in resp.data


def test_frontend_files(client):
    resp = client.get("/")
    assert resp.status_code == 200
    assert b"Amazon" in resp.data

    resp_js = client.get("/app.js")
    assert resp_js.status_code == 200

    resp_css = client.get("/style.css")
    assert resp_css.status_code == 200


# ---------------------------------------------------------------------------
# Cart session helpers
# ---------------------------------------------------------------------------

def test_uuid_uniqueness():
    s1 = str(uuid.uuid4())
    s2 = str(uuid.uuid4())
    assert s1 != s2


def test_product_row_to_dict(client):
    from server import row_to_product
    class MockRow:
        def __init__(self):
            self._data = {
                "id": 99,
                "title": "Mock Product",
                "image": "mock.jpg",
                "price": 49.99,
                "original_price": 59.99,
                "rating": 4.5,
                "rating_count": 1000,
                "category": "test",
                "badge": "deal",
                "description": "A mock product",
                "features": "A|B|C",
                "stock": 50,
                "images": "",
                "variants": "",
            }
        def __getitem__(self, key):
            return self._data[key]
    prod = row_to_product(MockRow())
    assert prod["id"] == 99
    assert prod["price"] == 49.99
    assert len(prod["features"]) == 3


# ---------------------------------------------------------------------------
# New Features Tests
# ---------------------------------------------------------------------------

def test_coupon_validate_percent(client):
    from server import init_db
    init_db()
    resp = client.post("/api/coupons/validate", json={"code": "WELCOME10", "cartTotal": 100})
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["valid"] is True
    assert data["discount"] == 10.0  # 10% of 100


def test_coupon_validate_fixed(client):
    resp = client.post("/api/coupons/validate", json={"code": "SAVE50", "cartTotal": 200})
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["valid"] is True
    assert data["discount"] == 50.0


def test_coupon_validate_invalid(client):
    resp = client.post("/api/coupons/validate", json={"code": "FAKE123", "cartTotal": 50})
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["valid"] is False


def test_coupon_min_cart(client):
    resp = client.post("/api/coupons/validate", json={"code": "SAVE50", "cartTotal": 10})
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["valid"] is False


def test_checkout_with_coupon(client):
    session_id = "test-coupon-checkout"
    payload = {
        "customerName": "Coupon User",
        "email": "coupon@example.com",
        "address": "456 Coupon Ln",
        "paymentMethod": "card",
        "couponCode": "WELCOME10",
        "items": [{"id": 1, "quantity": 2, "product": {"title": "Item", "price": 50.0, "image": ""}}],
        "clearCartAfterCheckout": True,
    }
    resp = client.post(f"/api/cart/{session_id}/checkout", json=payload)
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["total"] == 90.0  # $100 - 10% = $90


def test_price_history(client):
    session_id = "test-ph"
    payload = {
        "customerName": "PH User", "email": "ph@e.com", "address": "Addr",
        "paymentMethod": "card",
        "items": [{"id": 1, "quantity": 1, "product": {"title": "P", "price": 25, "image": ""}}],
    }
    client.post(f"/api/cart/{session_id}/checkout", json=payload)
    resp = client.get("/api/products/1/price-history")
    assert resp.status_code == 200
    data = resp.get_json()
    assert "currentPrice" in data
    assert "history" in data
    assert len(data["history"]) >= 1


def test_also_bought(client):
    resp = client.get("/api/products/1/also-bought")
    assert resp.status_code == 200
    data = resp.get_json()
    assert isinstance(data, list)


def test_wishlist_share(client):
    session_id = "test-share"
    client.post(f"/api/wishlist/{session_id}", json={"productId": 1})
    resp = client.get(f"/api/wishlist/{session_id}/share")
    assert resp.status_code == 200
    data = resp.get_json()
    assert "token" in data
    assert "url" in data
    # View shared wishlist
    resp2 = client.get(f"/api/wishlist/share/{data['token']}")
    assert resp2.status_code == 200
    data2 = resp2.get_json()
    assert len(data2["products"]) >= 1


def test_order_tracking_fields(client):
    session_id = "test-tracking"
    payload = {
        "customerName": "Track User", "email": "track@e.com", "address": "Addr",
        "paymentMethod": "card",
        "items": [{"id": 1, "quantity": 1, "product": {"title": "T", "price": 10, "image": ""}}],
    }
    resp = client.post(f"/api/cart/{session_id}/checkout", json=payload)
    data = resp.get_json()
    oid = data["orderId"]
    # Get order details
    resp2 = client.get(f"/api/orders/{oid}")
    assert resp2.status_code == 200
    d2 = resp2.get_json()
    assert "trackingCode" in d2
    assert d2["trackingCode"].startswith("TRK-")
    assert "trackingUpdates" in d2
    assert len(d2["trackingUpdates"]) >= 1
