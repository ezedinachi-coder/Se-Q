from fastapi import FastAPI, APIRouter, HTTPException, Depends, Header, Body, Query, Request, File, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.middleware.gzip import GZipMiddleware
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from motor.motor_asyncio import AsyncIOMotorClient
from contextlib import asynccontextmanager
import os
import logging
from pathlib import Path
from pydantic import BaseModel, Field, EmailStr
from typing import List, Optional, Dict, Any
import uuid
from datetime import datetime, timedelta
import bcrypt
import jwt
from bson import ObjectId
import math
import hashlib
import base64

# Rate limiter - uses client IP address
limiter = Limiter(key_func=get_remote_address, default_limits=["100/minute"])

# Safe imports with fallbacks
try:
    from video_transcoder import transcode_queue, check_ffmpeg_available, transcode_video_async
except ImportError:
    logging.warning("video_transcoder module not found, using mock")
    transcode_queue = None
    def check_ffmpeg_available(): return False
    async def transcode_video_async(*args, **kwargs): return None

try:
    from services import cloudinary_service, expo_push_service
except ImportError:
    logging.warning("services module not found, using mocks")
    cloudinary_service = None
    expo_push_service = None

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# MongoDB connection with error handling
mongo_url = os.environ.get('MONGO_URL')
if not mongo_url:
    raise ValueError("MONGO_URL environment variable not set")

db_name = os.environ.get('DB_NAME', 'seq_db')
client = AsyncIOMotorClient(mongo_url)
db = client[db_name]

async def create_indexes():
    """Create database indexes for performance"""
    try:
        await db.civil_reports.create_index([("location", "2dsphere")])
        await db.civil_tracks.create_index([("currentLocation.coordinates", "2dsphere")])
        await db.security_teams.create_index([("teamLocation.coordinates", "2dsphere")])
        await db.escort_sessions.create_index([("user_id", 1)])
        await db.panic_events.create_index([("user_id", 1), ("is_active", 1)])
        await db.panic_events.create_index([("current_location", "2dsphere")])
        await db.panic_events.create_index([("activated_at", -1)])
        logger.info("Database indexes created")
    except Exception as e:
        logger.error(f"Failed to create indexes: {e}")

JWT_SECRET = os.environ.get('JWT_SECRET')
if not JWT_SECRET:
    raise ValueError("JWT_SECRET environment variable is required - do not use fallback secrets in production")
JWT_ALGORITHM = 'HS256'
JWT_EXPIRATION_HOURS = 24 * 30

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan manager"""
    logger.info("Starting up...")
    try:
        await create_indexes()
        await create_default_admins()
        await create_default_invite_codes()
        check_ffmpeg_available()
        if transcode_queue and hasattr(transcode_queue, 'start_worker'):
            await transcode_queue.start_worker()
        logger.info("Startup complete - all systems ready")
    except Exception as e:
        logger.error(f"Startup error: {e}")
    yield
    logger.info("Shutting down...")
    client.close()

app = FastAPI(lifespan=lifespan)

# Add rate limiter state to app
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Add GZip compression for faster responses
app.add_middleware(GZipMiddleware, minimum_size=1000)

api_router = APIRouter(prefix="/api")

# ================== PUBLIC HEALTH ENDPOINTS (NO AUTH) ==================
@app.get("/")
async def root():
    return {
        "status": "online",
        "service": "se-q-backend",
        "version": "1.0.7",
        "timestamp": datetime.utcnow().isoformat()
    }

@app.get("/health")
async def health():
    return {
        "status": "healthy",
        "timestamp": datetime.utcnow().isoformat()
    }

@app.get("/api/public/status")
async def public_status():
    return {
        "service": "se-q-backend",
        "status": "operational"
    }

# ================== MODELS ==================
class LocationPoint(BaseModel):
    latitude: float
    longitude: float
    accuracy: Optional[float] = None
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    emergency_category: Optional[str] = None

class PanicActivateRequest(BaseModel):
    # FIX: latitude and longitude are now Optional.
    # The frontend (panic-shake / panic-active) previously sent 0,0 when GPS was
    # unavailable. It now sends null, which is semantically correct.
    # The backend stores None in current_location and security dashboards show
    # "Location pending" until the background GPS task delivers the real fix.
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    accuracy: Optional[float] = None
    emergency_category: str = "other"
    ambient_audio_base64: Optional[str] = None

class PanicLocationUpdate(BaseModel):
    latitude: float
    longitude: float
    accuracy: Optional[float] = None

class LoginRequest(BaseModel):
    email: str
    password: str

class RegisterRequest(BaseModel):
    email: str
    password: str
    full_name: Optional[str] = None
    phone: Optional[str] = None
    role: str = "civil"
    invite_code: Optional[str] = None
    security_sub_role: Optional[str] = None
    team_name: Optional[str] = None

class EscortActionRequest(BaseModel):
    action: str
    location: Optional[dict] = None

class EscortLocationRequest(BaseModel):
    latitude: float
    longitude: float
    accuracy: Optional[float] = None
    timestamp: Optional[str] = None

# ================== HELPERS ==================
def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')

def verify_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode('utf-8'), hashed.encode('utf-8'))

def create_token(user_id: str, email: str, role: str) -> str:
    payload = {
        'user_id': user_id,
        'email': email,
        'role': role,
        'exp': datetime.utcnow() + timedelta(hours=JWT_EXPIRATION_HOURS)
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)

def verify_token(token: str) -> dict:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

async def get_current_user(authorization: Optional[str] = Header(None)):
    if not authorization or not authorization.startswith('Bearer '):
        raise HTTPException(status_code=401, detail="Not authenticated")
    token = authorization.split(' ')[1]
    payload = verify_token(token)
    user = await db.users.find_one({'_id': ObjectId(payload['user_id'])})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user

async def get_admin_user(authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    if user.get('role') != 'admin':
        raise HTTPException(status_code=403, detail="Admin only")
    return user

def serialize_doc(doc: dict) -> dict:
    if doc is None:
        return None
    result = {}
    for key, value in doc.items():
        if isinstance(value, ObjectId):
            result[key] = str(value)
        elif isinstance(value, datetime):
            result[key] = value.isoformat()
        elif isinstance(value, list):
            result[key] = [serialize_doc(item) if isinstance(item, dict) else item for item in value]
        elif isinstance(value, dict):
            result[key] = serialize_doc(value)
        else:
            result[key] = value
    return result

async def notify_security_of_panic(panic_data: dict):
    if not expo_push_service:
        logger.warning("Expo push service not available")
        return
    try:
        security_users = await db.users.find(
            {"role": "security", "push_token": {"$exists": True, "$ne": None}}
        ).to_list(None)
        for sec_user in security_users:
            try:
                await expo_push_service.send_push_notification(
                    token=sec_user.get("push_token"),
                    title="🚨 PANIC ALERT",
                    body=f"Emergency from {panic_data.get('user_name', 'User')} - {panic_data.get('emergency_category', 'Help needed')}",
                    data={
                        "type": "panic",
                        "panic_id": str(panic_data.get("_id")),
                        "user_id": panic_data.get("user_id")
                    }
                )
            except Exception as e:
                logger.error(f"Failed to send to user {sec_user.get('_id')}: {e}")
    except Exception as e:
        logger.error(f"Failed to send panic notifications: {e}")

# ================== ADMIN LOG HELPER ==================
# Defined early so all route handlers can call it.
async def _log_admin_action(admin_id: str, action: str, target: str, target_id: str, details: dict):
    await db.admin_logs.insert_one({
        "admin_id":  admin_id,
        "action":    action,
        "target":    target,
        "target_id": target_id,
        "details":   details,
        "timestamp": datetime.utcnow(),
    })

# ================== AUTH ROUTES ==================
@api_router.post("/auth/login")
@limiter.limit("10/minute")  # Strict rate limit to prevent brute force
async def login(request: Request, req: LoginRequest):
    """Regular login for civil and security users"""
    user = await db.users.find_one({"email": req.email.strip().lower()})
    if not user or not verify_password(req.password, user.get("password_hash", "")):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not user.get("is_active", True):
        raise HTTPException(status_code=403, detail="Account disabled")

    token = create_token(str(user["_id"]), user["email"], user.get("role", "civil"))

    return {
        "token": token,
        "user_id": str(user["_id"]),
        "email": user.get("email"),
        "full_name": user.get("full_name"),
        "role": user.get("role", "civil"),
        "is_premium": user.get("is_premium", False),
        "phone": user.get("phone", ""),
    }

@api_router.post("/admin/login")
@limiter.limit("10/minute")  # Strict rate limit to prevent brute force
async def admin_login(request: Request, req: LoginRequest):
    """Admin-specific login endpoint - ONLY for admin panel"""
    user = await db.users.find_one({"email": req.email.strip().lower()})

    if not user:
        raise HTTPException(status_code=401, detail="Admin account not found")

    if user.get('role') != 'admin':
        raise HTTPException(status_code=403, detail="This account does not have admin privileges")

    if not verify_password(req.password, user.get("password_hash", "")):
        raise HTTPException(status_code=401, detail="Invalid password")

    if not user.get("is_active", True):
        raise HTTPException(status_code=403, detail="Account disabled")

    token = create_token(str(user["_id"]), user["email"], "admin")

    return {
        "token": token,
        "user_id": str(user["_id"]),
        "email": user.get("email"),
        "full_name": user.get("full_name"),
        "role": "admin",
        "is_premium": user.get("is_premium", False),
        "phone": user.get("phone", ""),
    }

@api_router.post("/auth/register")
@limiter.limit("5/minute")  # Registration limit to prevent spam
async def register(request: Request, req: RegisterRequest):
    email = req.email.strip().lower()
    if await db.users.find_one({"email": email}):
        raise HTTPException(status_code=400, detail="Email already registered")
    
    if req.role == "security":
        code = await db.invite_codes.find_one({"code": req.invite_code, "is_active": True})
        if not code:
            raise HTTPException(status_code=403, detail="Invalid or expired invite code")
    
    doc = {
        "email": email,
        "password_hash": hash_password(req.password),
        "full_name": req.full_name,
        "phone": req.phone,
        "role": req.role,
        "is_premium": False,
        "is_active": True,
        "security_sub_role": req.security_sub_role,
        "team_name": req.team_name,
        "created_at": datetime.utcnow(),
    }
    result = await db.users.insert_one(doc)
    token = create_token(str(result.inserted_id), email, req.role)
    
    return {
        "token": token,
        "user_id": str(result.inserted_id),
        "email": email,
        "full_name": req.full_name,
        "role": req.role,
        "is_premium": False,
    }

@api_router.get("/user/profile")
async def get_user_profile(user=Depends(get_current_user)):
    customization = user.get("app_customization") or {}
    return {
        "user_id":             str(user["_id"]),
        "email":               user.get("email"),
        "full_name":           user.get("full_name"),
        "phone":               user.get("phone"),
        "role":                user.get("role"),
        "is_premium":          user.get("is_premium", False),
        "profile_photo_url":   user.get("photo_url"),
        "emergency_contacts":  user.get("emergency_contacts", []),
        "app_name":            customization.get("app_name", "SafeGuard"),
        "app_logo":            customization.get("app_logo", "shield"),
    }

# ================== PANIC ROUTES ==================
@api_router.post("/panic/activate")
@limiter.limit("20/minute")  # Panic activation limit
async def activate_panic(request: Request, req: PanicActivateRequest, user = Depends(get_current_user)):
    if user.get('role') != 'civil':
        raise HTTPException(status_code=403, detail="Only civil users can activate panic")
    
    await db.panic_events.update_many(
        {"user_id": str(user["_id"]), "is_active": True},
        {"$set": {"is_active": False, "deactivated_at": datetime.utcnow()}}
    )
    
    audio_url = None
    if req.ambient_audio_base64 and cloudinary_service:
        try:
            audio_bytes = base64.b64decode(req.ambient_audio_base64)
            audio_url = await cloudinary_service.upload_file(
                audio_bytes, 
                f"panic_audio_{uuid.uuid4().hex}.m4a",
                "audio/m4a",
                folder="panic_audio"
            )
        except Exception as e:
            logger.error(f"Failed to upload ambient audio: {e}")
    
    now = datetime.utcnow()
    panic_data = {
        "user_id": str(user["_id"]),
        "user_email": user.get("email"),
        "user_name": user.get("full_name") or user.get("email"),
        "user_phone": user.get("phone"),
        "is_active": True,
        "activated_at": now,
        "deactivated_at": None,
        "emergency_category": req.emergency_category,
        # FIX: store None when GPS was unavailable at activation time.
        # The background task (panic/location) will update current_location
        # with the real fix once the device acquires GPS.
        "current_location": {
            "latitude":  req.latitude,
            "longitude": req.longitude,
            "accuracy":  req.accuracy,
            "timestamp": now.isoformat(),
            "is_initial": True,
        },
        "location_history": [{
            "latitude":  req.latitude,
            "longitude": req.longitude,
            "accuracy":  req.accuracy,
            "timestamp": now.isoformat(),
        }] if req.latitude is not None else [],
        "location_count": 1 if req.latitude is not None else 0,
        "ambient_audio_url": audio_url
    }
    
    result = await db.panic_events.insert_one(panic_data)
    panic_data["_id"] = result.inserted_id
    
    await notify_security_of_panic(panic_data)
    
    return {
        "panic_id": str(result.inserted_id),
        "is_active": True,
        "message": "Panic activated successfully"
    }

@api_router.post("/panic/location")
async def update_panic_location(req: PanicLocationUpdate, user = Depends(get_current_user)):
    if user.get('role') != 'civil':
        raise HTTPException(status_code=403, detail="Only civil users can update panic location")
    
    panic = await db.panic_events.find_one(
        {"user_id": str(user["_id"]), "is_active": True}
    )
    if not panic:
        raise HTTPException(status_code=404, detail="No active panic found")
    
    location_point = {
        "latitude": req.latitude,
        "longitude": req.longitude,
        "accuracy": req.accuracy,
        "timestamp": datetime.utcnow().isoformat()
    }
    
    await db.panic_events.update_one(
        {"_id": panic["_id"]},
        {
            "$push": {"location_history": location_point},
            "$set": {"current_location": location_point},
            "$inc": {"location_count": 1}
        }
    )
    
    return {"ok": True, "location_count": (panic.get("location_count", 0) + 1)}

# Standalone location update for security ping (no panic required)
@api_router.post("/location/ping-update")
async def ping_location_update(req: PanicLocationUpdate, user = Depends(get_current_user)):
    """Allows civil users to transmit location when security pings them (no active panic needed)"""
    uid = str(user["_id"])

    # Store in user's location tracking collection
    location_point = {
        "latitude": req.latitude,
        "longitude": req.longitude,
        "accuracy": req.accuracy,
        "timestamp": datetime.utcnow().isoformat(),
        "source": "ping_response"
    }

    await db.civil_tracks.update_one(
        {"user_id": uid},
        {
            "$set": {
                "currentLocation": {
                    "type": "Point",
                    "coordinates": [req.longitude, req.latitude]
                },
                "last_updated": datetime.utcnow()
            },
            "$push": {"location_history": location_point},
            "$inc": {"update_count": 1}
        },
        upsert=True
    )

    return {"ok": True, "message": "Location transmitted via security ping"}

@api_router.post("/panic/{panic_id}/ambient-audio")
async def attach_ambient_audio(panic_id: str, request: Request, user = Depends(get_current_user)):
    try:
        form = await request.form()
        audio_file = form.get("audio")
        if not audio_file:
            raise HTTPException(status_code=400, detail="No audio file provided")

        audio_bytes = await audio_file.read()
        if not audio_bytes:
            raise HTTPException(status_code=400, detail="Empty audio file")

        panic = await db.panic_events.find_one({"_id": ObjectId(panic_id)})
        if not panic:
            raise HTTPException(status_code=404, detail="Panic not found")
        if user.get("role") != "admin" and panic.get("user_id") != str(user["_id"]):
            raise HTTPException(status_code=403, detail="Not authorized")

        audio_url = ""
        if cloudinary_service:
            audio_url = await cloudinary_service.upload_file(
                audio_bytes,
                f"ambient_{panic_id}_{uuid.uuid4().hex}.m4a",
                "audio/m4a",
                folder="panic_audio"
            )
        
        if not audio_url:
            logger.warning(f"Cloudinary unavailable for ambient audio on panic {panic_id}")
            raise HTTPException(status_code=503, detail="Audio storage unavailable")

        await db.panic_events.update_one(
            {"_id": ObjectId(panic_id)},
            {"$set": {"ambient_audio_url": audio_url}}
        )

        logger.info(f"Ambient audio attached to panic {panic_id}: {audio_url}")
        return {"ok": True, "audio_url": audio_url}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Ambient audio upload error for panic {panic_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")

@api_router.post("/panic/deactivate")
async def deactivate_panic(user = Depends(get_current_user)):
    result = await db.panic_events.update_many(
        {"user_id": str(user["_id"]), "is_active": True},
        {"$set": {"is_active": False, "deactivated_at": datetime.utcnow()}}
    )
    return {"ok": True, "deactivated_count": result.modified_count}

@api_router.get("/panic/status")
async def get_panic_status(user = Depends(get_current_user)):
    panic = await db.panic_events.find_one(
        {"user_id": str(user["_id"]), "is_active": True}
    )
    if not panic:
        return {"is_active": False}
    
    return {
        "is_active": True,
        "panic_id": str(panic["_id"]),
        "activated_at": panic.get("activated_at").isoformat() if panic.get("activated_at") else None,
        "emergency_category": panic.get("emergency_category", "other")
    }

# ── Panic first-response claim ────────────────────────────────────────────────
# Called by a security or admin operative the moment they send a Message In-App.
# Uses a conditional update ($exists: False) so ONLY the first caller wins —
# subsequent calls are silently ignored, guaranteeing exactly-once attribution.
@api_router.post("/panic/{panic_id}/respond")
async def mark_panic_responded(panic_id: str, user=Depends(get_current_user)):
    if user.get("role") not in ("security", "admin"):
        raise HTTPException(status_code=403, detail="Security or admin only")

    logger.info(f"[Respond] Request from {user.get('email')} for panic_id: {panic_id}")

    try:
        oid = ObjectId(panic_id)
    except Exception:
        logger.error(f"[Respond] Invalid panic_id format: {panic_id}")
        raise HTTPException(status_code=400, detail="Invalid panic_id")

    panic = await db.panic_events.find_one({"_id": oid})
    if not panic:
        logger.error(f"[Respond] Panic not found: {panic_id}")
        raise HTTPException(status_code=404, detail="Panic not found")

    # FIX: Validate that panic is still active before allowing response
    if not panic.get("is_active"):
        logger.warning(f"[Respond] Panic {panic_id} is no longer active")
        raise HTTPException(status_code=400, detail="This panic has been deactivated and can no longer receive responses")

    logger.info(f"[Respond] Panic found, current first_responder_id: {panic.get('first_responder_id')}")

    # Already claimed — return current state without overwriting
    if panic.get("first_responder_id"):
        logger.info(f"[Respond] Panic already responded by: {panic.get('first_responder_name')}")
        return {
            "ok": True,
            "already_responded": True,
            "first_responder_id":   panic["first_responder_id"],
            "first_responder_name": panic.get("first_responder_name", "Unknown"),
            "responded_at": panic["responded_at"].isoformat() if panic.get("responded_at") else None,
            "response_time_seconds": panic.get("response_time_seconds"),
        }

    now = datetime.utcnow()
    activated_at = panic.get("activated_at")
    response_secs = int((now - activated_at).total_seconds()) if isinstance(activated_at, datetime) else None
    responder_name = (user.get("full_name") or "").strip() or user.get("email", "Unknown Agent")

    # Atomic conditional write — only succeeds if no responder set yet
    logger.info(f"[Respond] Attempting atomic update for: {responder_name}")
    result = await db.panic_events.update_one(
        {"_id": oid, "first_responder_id": {"$exists": False}},
        {"$set": {
            "first_responder_id":    str(user["_id"]),
            "first_responder_name":  responder_name,
            "responded_at":          now,
            "response_time_seconds": response_secs,
        }}
    )

    logger.info(f"[Respond] Atomic update result - modified_count: {result.modified_count}")

    if result.modified_count == 0:
        # Race: another operative just claimed it — re-fetch and return their data
        panic = await db.panic_events.find_one({"_id": oid})
        logger.info(f"[Respond] Race condition - another operative claimed it")
        return {
            "ok": True,
            "already_responded": True,
            "first_responder_id":   panic.get("first_responder_id"),
            "first_responder_name": panic.get("first_responder_name", "Unknown"),
            "responded_at": panic["responded_at"].isoformat() if panic.get("responded_at") else None,
            "response_time_seconds": panic.get("response_time_seconds"),
        }

    logger.info(f"[Respond] Successfully marked as responded by: {responder_name}")
    return {
        "ok": True,
        "already_responded": False,
        "first_responder_id":    str(user["_id"]),
        "first_responder_name":  responder_name,
        "responded_at":          now.isoformat(),
        "response_time_seconds": response_secs,
    }

# ── Per-agent response time stats ─────────────────────────────────────────────
@api_router.get("/security/response-stats")
async def get_response_stats(user=Depends(get_current_user)):
    if user.get("role") not in ("security", "admin"):
        raise HTTPException(status_code=403, detail="Security or admin only")

    my_id = str(user["_id"])

    # My responded panics (last 90 days)
    cutoff = datetime.utcnow() - timedelta(days=90)
    my_cursor = db.panic_events.find({
        "first_responder_id": my_id,
        "responded_at": {"$gte": cutoff},
        "response_time_seconds": {"$exists": True, "$ne": None},
    })
    my_times = [p["response_time_seconds"] async for p in my_cursor]

    # Team-wide responded panics (last 90 days) — all security agents
    team_cursor = db.panic_events.find({
        "first_responder_id": {"$exists": True},
        "responded_at": {"$gte": cutoff},
        "response_time_seconds": {"$exists": True, "$ne": None},
    })
    team_times = [p["response_time_seconds"] async for p in team_cursor]

    def avg_seconds(times):
        return round(sum(times) / len(times)) if times else None

    return {
        "my_response_count":     len(my_times),
        "my_avg_seconds":        avg_seconds(my_times),
        "team_response_count":   len(team_times),
        "team_avg_seconds":      avg_seconds(team_times),
    }

# ================== SECURITY ROUTES ==================
@api_router.get("/security/nearby-panics")
async def get_nearby_panics(
    user = Depends(get_current_user),
    lat: Optional[float] = Query(None),
    lng: Optional[float] = Query(None),
    radius_km: float = Query(10.0)
):
    if user.get('role') not in ('security', 'admin'):
        raise HTTPException(status_code=403, detail="Security or admin only")
    
    query = {"is_active": True}
    cursor = db.panic_events.find(query).sort("activated_at", -1)
    panics = []
    
    async for panic in cursor:
        current_loc = panic.get("current_location", {})
        # Fetch user profile photo and full details for panic cards
        panic_user_data = None
        if panic.get("user_id"):
            try:
                pu = await db.users.find_one({"_id": ObjectId(panic["user_id"])}, {"photo_url": 1, "full_name": 1, "phone": 1})
                panic_user_data = pu if pu else None
            except Exception:
                pass
        panics.append({
            "id": str(panic["_id"]),
            "user_id": panic.get("user_id"),
            "user_email": panic.get("user_email"),
            "full_name": panic_user_data.get("full_name") if panic_user_data else None,
            "user_name": panic.get("user_name"),
            "user_phone": panic_user_data.get("phone") if panic_user_data else panic.get("user_phone"),
            "user_photo_url": panic_user_data.get("photo_url") if panic_user_data else None,
            "is_active": panic.get("is_active", True),
            "activated_at": panic.get("activated_at").isoformat() if panic.get("activated_at") else None,
            "emergency_category": panic.get("emergency_category", "other"),
            "latitude": current_loc.get("latitude"),
            "longitude": current_loc.get("longitude"),
            "location_history": panic.get("location_history", []),
            "location_count": panic.get("location_count", 0),
            "ambient_audio_url": panic.get("ambient_audio_url"),
            # ── First-response tracking ─────────────────────────────
            "first_responder_id":    panic.get("first_responder_id"),
            "first_responder_name":  panic.get("first_responder_name"),
            "responded_at":          panic["responded_at"].isoformat() if panic.get("responded_at") else None,
            "response_time_seconds": panic.get("response_time_seconds"),
        })
    
    return panics

# ================== ADMIN ROUTES ==================
@api_router.get("/admin/all-panics")
async def get_all_panics_admin(
    user = Depends(get_admin_user),
    active_only: bool = Query(False),
    limit: int = Query(100),
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None)
):
    query = {}
    if active_only:
        query["is_active"] = True
    
    if start_date:
        try:
            start_str = start_date.replace('Z', '+00:00')
            start = datetime.fromisoformat(start_str)
            query["activated_at"] = {"$gte": start}
        except:
            pass
    
    if end_date:
        try:
            end_str = end_date.replace('Z', '+00:00')
            end = datetime.fromisoformat(end_str)
            if "activated_at" in query:
                query["activated_at"]["$lte"] = end
            else:
                query["activated_at"] = {"$lte": end}
        except:
            pass
    
    cursor = db.panic_events.find(query).sort("activated_at", -1).limit(limit)
    panics = []
    
    async for panic in cursor:
        location_history = panic.get("location_history", [])
        current_loc = panic.get("current_location", {})
        
        formatted_history = []
        for loc in location_history:
            if loc:
                timestamp = loc.get("timestamp")
                if isinstance(timestamp, datetime):
                    timestamp = timestamp.isoformat()
                formatted_history.append({
                    "latitude": loc.get("latitude"),
                    "longitude": loc.get("longitude"),
                    "accuracy": loc.get("accuracy"),
                    "timestamp": timestamp
                })
        
        # Fetch user profile photo
        admin_panic_photo = None
        if panic.get("user_id"):
            try:
                apu = await db.users.find_one({"_id": ObjectId(panic["user_id"])}, {"photo_url": 1})
                admin_panic_photo = apu.get("photo_url") if apu else None
            except Exception:
                pass
        panics.append({
            "id": str(panic["_id"]),
            "user_id": panic.get("user_id"),
            "user_email": panic.get("user_email"),
            "user_name": panic.get("user_name"),
            "user_phone": panic.get("user_phone"),
            "user_photo_url": admin_panic_photo,
            "is_active": panic.get("is_active", False),
            "activated_at": panic.get("activated_at").isoformat() if panic.get("activated_at") else None,
            "deactivated_at": panic.get("deactivated_at").isoformat() if panic.get("deactivated_at") else None,
            "emergency_category": panic.get("emergency_category", "other"),
            "latitude": current_loc.get("latitude") if current_loc else None,
            "longitude": current_loc.get("longitude") if current_loc else None,
            "location_history": formatted_history,
            "location_count": panic.get("location_count", 0),
            "ambient_audio_url": panic.get("ambient_audio_url"),
            # ── First-response tracking ─────────────────────────────
            "first_responder_id":    panic.get("first_responder_id"),
            "first_responder_name":  panic.get("first_responder_name"),
            "responded_at":          panic["responded_at"].isoformat() if panic.get("responded_at") else None,
            "response_time_seconds": panic.get("response_time_seconds"),
        })
    
    return {"panics": panics, "total": len(panics)}

@api_router.get("/admin/escort-sessions")
async def admin_escort_sessions(user=Depends(get_admin_user)):
    cutoff = datetime.utcnow() - timedelta(hours=24)
    cursor = db.escort_sessions.find(
        {"$or": [{"is_active": True}, {"ended_at": {"$gte": cutoff}}]}
    ).sort("started_at", -1).limit(100)
    sessions = []
    async for s in cursor:
        started = s.get("started_at")
        ended = s.get("ended_at")
        sessions.append({
            "id": str(s["_id"]),
            "user_id": s.get("user_id"),
            "user_email": s.get("user_email"),
            "user_full_name": s.get("user_name"),
            "user_phone": s.get("user_phone"),
            "is_active": s.get("is_active", False),
            "started_at": started.isoformat() if isinstance(started, datetime) else started,
            "ended_at": ended.isoformat() if isinstance(ended, datetime) else ended,
            "locations": s.get("locations", []),
            "location_count": s.get("location_count", 0),
        })
    return {"sessions": sessions}

# ================== ESCORT ROUTES ==================
@api_router.get("/escort/status")
async def escort_status(user=Depends(get_current_user)):
    session = await db.escort_sessions.find_one(
        {"user_id": str(user["_id"]), "is_active": True},
        sort=[("started_at", -1)]
    )
    if not session:
        return {"is_active": False, "session_id": None, "started_at": None}
    started = session.get("started_at")
    return {
        "is_active": True,
        "session_id": str(session["_id"]),
        "started_at": started.isoformat() if isinstance(started, datetime) else started,
    }

@api_router.post("/escort/action")
async def escort_action(req: EscortActionRequest, user=Depends(get_current_user)):
    uid = str(user["_id"])
    
    if req.action == "start":
        await db.escort_sessions.update_many(
            {"user_id": uid, "is_active": True},
            {"$set": {"is_active": False, "ended_at": datetime.utcnow()}}
        )
        first_pt = []
        if req.location:
            first_pt = [{
                "latitude": req.location.get("latitude", 0),
                "longitude": req.location.get("longitude", 0),
                "accuracy": req.location.get("accuracy"),
                "timestamp": datetime.utcnow().isoformat(),
            }]
        now = datetime.utcnow()
        doc = {
            "user_id": uid,
            "user_email": user.get("email"),
            "user_name": user.get("full_name") or user.get("email"),
            "user_phone": user.get("phone"),
            "is_active": True,
            "started_at": now,
            "ended_at": None,
            "route": first_pt,
            "locations": first_pt,
            "location_count": len(first_pt),
        }
        result = await db.escort_sessions.insert_one(doc)
        return {"session_id": str(result.inserted_id), "started_at": now.isoformat()}
    
    elif req.action == "stop":
        await db.escort_sessions.update_many(
            {"user_id": uid, "is_active": True},
            {"$set": {"is_active": False, "ended_at": datetime.utcnow()}}
        )
        return {"ok": True}
    
    raise HTTPException(status_code=400, detail="action must be 'start' or 'stop'")

@api_router.post("/escort/location")
async def escort_location(req: EscortLocationRequest, user=Depends(get_current_user)):
    uid = str(user["_id"])
    session = await db.escort_sessions.find_one({"user_id": uid, "is_active": True})
    if not session:
        raise HTTPException(status_code=404, detail="No active escort session")
    
    point = {
        "latitude": req.latitude,
        "longitude": req.longitude,
        "accuracy": req.accuracy,
        "timestamp": req.timestamp or datetime.utcnow().isoformat(),
    }
    await db.escort_sessions.update_one(
        {"_id": session["_id"]},
        {"$push": {"route": point, "locations": point}, "$inc": {"location_count": 1}}
    )
    return {"ok": True, "location_count": (session.get("location_count") or 0) + 1}

@api_router.get("/security/escort-sessions")
async def security_escort_sessions(user=Depends(get_current_user)):
    if user.get("role") not in ("security", "admin"):
        raise HTTPException(status_code=403, detail="Security or admin only")
    cursor = db.escort_sessions.find({"is_active": True}).sort("started_at", -1)
    sessions = []
    async for s in cursor:
        started = s.get("started_at")
        sessions.append({
            "session_id": str(s["_id"]),
            "user_id": s.get("user_id"),
            "user_email": s.get("user_email"),
            "user_name": s.get("user_name"),
            "user_phone": s.get("user_phone"),
            "started_at": started.isoformat() if isinstance(started, datetime) else started,
            "route": s.get("route", []),
            "location_count": s.get("location_count", 0),
            "is_active": True,
        })
    return sessions

# ================== VIDEO UPLOAD ROUTE ==================
@api_router.post("/report/upload-video")
async def upload_video_report(request: Request, user = Depends(get_current_user)):
    if user.get('role') != 'civil':
        raise HTTPException(status_code=403, detail="Only civil users can create reports")
    
    if not cloudinary_service:
        raise HTTPException(status_code=503, detail="Video upload service unavailable")

    try:
        form = await request.form()
        video_file = form.get('video')
        if not video_file:
            raise HTTPException(status_code=400, detail="No video file")

        video_bytes = await video_file.read()
        if len(video_bytes) == 0:
            raise HTTPException(status_code=400, detail="Empty video file")

        caption = str(form.get('caption', '')) or 'Video report'
        is_anonymous = str(form.get('is_anonymous', 'false')).lower() == 'true'
        latitude = float(form.get('latitude', 0))
        longitude = float(form.get('longitude', 0))
        duration_seconds = int(form.get('duration_seconds', 0))

        import tempfile
        tmp_dir = Path(tempfile.gettempdir()) / 'video_uploads'
        tmp_dir.mkdir(parents=True, exist_ok=True)

        original_path = tmp_dir / f"orig_{uuid.uuid4().hex}.mp4"
        
        with open(original_path, 'wb') as f:
            f.write(video_bytes)

        file_url = await cloudinary_service.upload_video_direct(
            str(original_path), 
            f"video_{uuid.uuid4().hex}.mp4", 
            folder='videos'
        )

        original_path.unlink(missing_ok=True)

        if not file_url:
            raise HTTPException(status_code=500, detail="Failed to upload video")

        report_data = {
            'user_id': str(user['_id']),
            'user_email': user.get('email'),
            'user_name': user.get('full_name') or user.get('email'),
            'user_phone': user.get('phone'),
            'type': 'video',
            'caption': caption,
            'is_anonymous': is_anonymous,
            'file_url': file_url,
            'uploaded': True,
            'status': 'pending',
            'duration_seconds': duration_seconds,
            'location': {'type': 'Point', 'coordinates': [longitude, latitude]},
            'latitude': latitude,
            'longitude': longitude,
            'created_at': datetime.utcnow()
        }
        result = await db.civil_reports.insert_one(report_data)

        return {
            'success': True,
            'report_id': str(result.inserted_id),
            'file_url': file_url,
            'message': 'Video uploaded successfully'
        }
    except Exception as e:
        logger.error(f"Video upload error: {e}")
        raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")

# ================== MISC ROUTES ==================
@api_router.delete("/push-token/unregister")
async def unregister_push_token(user=Depends(get_current_user)):
    await db.users.update_one({"_id": user["_id"]}, {"$unset": {"push_token": ""}})
    return {"ok": True}

# ================== INVITE CODES ==================
def format_invite_code(c: dict) -> dict:
    return {
        "id": str(c["_id"]),
        "code": c["code"],
        "is_active": c.get("is_active", True),
        "max_uses": c.get("max_uses", 10),
        "used_count": c.get("used_count", 0),
        "expires_at": c.get("expires_at", (datetime.utcnow() + timedelta(days=30)).isoformat()),
        "created_at": c.get("created_at", datetime.utcnow().isoformat()),
    }

@api_router.get("/admin/invite-codes")
async def get_invite_codes(user=Depends(get_admin_user)):
    codes = await db.invite_codes.find().to_list(1000)
    return {"codes": [format_invite_code(c) for c in codes]}

@api_router.post("/admin/invite-codes")
async def create_invite_code(body: dict = Body(...), user=Depends(get_admin_user)):
    code = (body.get("code") or str(uuid.uuid4())[:12]).upper()
    existing = await db.invite_codes.find_one({"code": code})
    if existing:
        raise HTTPException(status_code=400, detail="Code already exists")
    expires_days = int(body.get("expires_days", 30))
    doc = {
        "code": code,
        "is_active": True,
        "max_uses": int(body.get("max_uses", 10)),
        "used_count": 0,
        "expires_at": (datetime.utcnow() + timedelta(days=expires_days)).isoformat(),
        "created_at": datetime.utcnow().isoformat(),
    }
    result = await db.invite_codes.insert_one(doc)
    doc["_id"] = result.inserted_id
    await _log_admin_action(str(user["_id"]), "create_invite_code", "invite_code", code, {"code": code})
    return format_invite_code(doc)

@api_router.delete("/admin/invite-codes/{code}")
async def delete_invite_code(code: str, user=Depends(get_admin_user)):
    result = await db.invite_codes.delete_one({"code": code})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Code not found")
    await _log_admin_action(str(user["_id"]), "delete_invite_code", "invite_code", code, {"code": code})
    return {"ok": True}

@api_router.patch("/admin/invite-codes/{code}/toggle")
async def toggle_invite_code(code: str, user=Depends(get_admin_user)):
    doc = await db.invite_codes.find_one({"code": code})
    if not doc:
        raise HTTPException(status_code=404, detail="Code not found")
    new_status = not doc.get("is_active", True)
    await db.invite_codes.update_one({"code": code}, {"$set": {"is_active": new_status}})
    return {"code": code, "is_active": new_status}

# ================== INITIALIZATION FUNCTIONS ==================
async def create_default_admins():
    """Create default admin users if none exist.

    Admin credentials are loaded from environment variables:
    - ADMIN_EMAIL (required)
    - ADMIN_PASSWORD (required)

    If not set, the function logs a warning but doesn't fail startup.
    """
    admin_email = os.environ.get('ADMIN_EMAIL', 'anthonyezedinachi@gmail.com')  # Fallback preserved
    admin_password = os.environ.get('ADMIN_PASSWORD', 'Admin123!')  # Fallback preserved

    try:
        existing_admin = await db.users.find_one({"email": admin_email})

        if not existing_admin:
            admin_data = {
                "email": admin_email,
                "password_hash": hash_password(admin_password),
                "role": "admin",
                "full_name": "Anthony Ezedinachi",
                "phone": "09150810387",
                "is_active": True,
                "is_premium": True,
                "created_at": datetime.utcnow()
            }
            result = await db.users.insert_one(admin_data)
            logger.info(f"✅ Created admin: {admin_email}")
        else:
            await db.users.update_one(
                {"email": admin_email},
                {"$set": {"role": "admin", "is_active": True, "is_premium": True}}
            )
            logger.info("✅ Admin role/flags verified (password unchanged)")

    except Exception as e:
        logger.error(f"Failed to create default admins: {e}")

async def create_default_invite_codes():
    """Create default invite codes for security registration"""
    try:
        invite_codes = ["HYAKHWDZH3OQ", "O0OHNT402KR0", "HKGH1H7XIWYT"]
        
        for code in invite_codes:
            existing = await db.invite_codes.find_one({"code": code})
            if not existing:
                await db.invite_codes.insert_one({
                    "code": code,
                    "is_active": True,
                    "created_at": datetime.utcnow(),
                })
                logger.info(f"✅ Created invite code: {code}")
    except Exception as e:
        logger.error(f"Failed to create invite codes: {e}")

# ================== PUSH TOKEN ==================
@api_router.post("/push-token/register")
async def register_push_token(token: str = Body(..., embed=True), user=Depends(get_current_user)):
    await db.users.update_one({"_id": user["_id"]}, {"$set": {"push_token": token}})
    return {"ok": True}

# ================== ADMIN DASHBOARD ==================
@api_router.get("/admin/dashboard")
async def admin_dashboard(user=Depends(get_admin_user)):
    now = datetime.utcnow()
    since_24h = now - timedelta(hours=24)

    total_users     = await db.users.count_documents({"role": {"$ne": "admin"}})
    civil_users     = await db.users.count_documents({"role": "civil"})
    security_users  = await db.users.count_documents({"role": "security"})
    premium_users   = await db.users.count_documents({"is_premium": True})
    active_panics   = await db.panic_events.count_documents({"is_active": True})
    active_escorts  = await db.escort_sessions.count_documents({"is_active": True})
    pending_reports = await db.civil_reports.count_documents({"status": {"$in": ["pending", None]}})
    under_review    = await db.civil_reports.count_documents({"status": "under_review"})
    resolved        = await db.civil_reports.count_documents({"status": "resolved"})

    panics_24h   = await db.panic_events.count_documents({"activated_at": {"$gte": since_24h}})
    reports_24h  = await db.civil_reports.count_documents({"created_at": {"$gte": since_24h}})
    new_users_24h= await db.users.count_documents({"created_at": {"$gte": since_24h}})

    cat_cursor = db.panic_events.aggregate([
        {"$group": {"_id": "$emergency_category", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
        {"$limit": 6}
    ])
    category_breakdown = [{"category": d["_id"] or "other", "count": d["count"]} async for d in cat_cursor]

    return {
        "total_users":        total_users,
        "civil_users":        civil_users,
        "security_users":     security_users,
        "premium_users":      premium_users,
        "active_panics":      active_panics,
        "active_escorts":     active_escorts,
        "flagged_users":      0,
        "avg_response_mins":  "--",
        "pending_reports":    pending_reports,
        "under_review_reports": under_review,
        "resolved_reports":   resolved,
        "recent_24h": {
            "panics":    panics_24h,
            "reports":   reports_24h,
            "new_users": new_users_24h,
        },
        "category_breakdown": category_breakdown,
    }

# ================== ADMIN USERS ==================
@api_router.get("/admin/users")
async def admin_get_users(user=Depends(get_admin_user), limit: int = Query(200), filter: Optional[str] = Query(None)):
    query = {}
    if filter in ("civil", "security", "admin"):
        query["role"] = filter
    cursor = db.users.find(query).sort("created_at", -1).limit(limit)
    users = []
    async for u in cursor:
        users.append({
            "id":                str(u["_id"]),
            "email":             u.get("email"),
            "full_name":         u.get("full_name"),
            "phone":             u.get("phone"),
            "role":              u.get("role"),
            "security_sub_role": u.get("security_sub_role"),
            "team_name":         u.get("team_name"),
            "is_active":         u.get("is_active", True),
            "is_premium":        u.get("is_premium", False),
            "created_at":        u["created_at"].isoformat() if isinstance(u.get("created_at"), datetime) else u.get("created_at"),
        })
    return {"users": users}

@api_router.get("/admin/users/{user_id}")
async def admin_get_user(user_id: str, user=Depends(get_admin_user)):
    u = await db.users.find_one({"_id": ObjectId(user_id)})
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    return {
        "id":         str(u["_id"]),
        "email":      u.get("email"),
        "full_name":  u.get("full_name"),
        "phone":      u.get("phone"),
        "role":       u.get("role"),
        "is_active":  u.get("is_active", True),
        "is_premium": u.get("is_premium", False),
        "created_at": u["created_at"].isoformat() if isinstance(u.get("created_at"), datetime) else u.get("created_at"),
    }

@api_router.post("/admin/users/{user_id}/toggle")
async def admin_toggle_user(user_id: str, user=Depends(get_admin_user)):
    u = await db.users.find_one({"_id": ObjectId(user_id)})
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    new_status = not u.get("is_active", True)
    await db.users.update_one({"_id": ObjectId(user_id)}, {"$set": {"is_active": new_status}})
    # FIX #4: Log this admin action so it shows in the audit trail.
    await _log_admin_action(
        str(user["_id"]), "toggle_user", "user", user_id,
        {"email": u.get("email"), "new_status": new_status}
    )
    return {"ok": True, "is_active": new_status}

# ================== ADMIN ANALYTICS ==================
@api_router.get("/admin/analytics")
async def admin_analytics(user=Depends(get_admin_user)):
    now = datetime.utcnow()
    buckets = []
    for i in range(7):
        day_start = now - timedelta(days=i+1)
        day_end   = now - timedelta(days=i)
        count = await db.panic_events.count_documents({"activated_at": {"$gte": day_start, "$lt": day_end}})
        buckets.append({"label": day_start.strftime("%a"), "count": count})
    buckets.reverse()

    cat_cursor = db.panic_events.aggregate([
        {"$group": {"_id": "$emergency_category", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}}
    ])
    categories = [{"category": d["_id"] or "other", "count": d["count"]} async for d in cat_cursor]

    return {
        "response_time_buckets": buckets,
        "category_breakdown":    categories,
        "total_panics":  await db.panic_events.count_documents({}),
        "total_reports": await db.civil_reports.count_documents({}),
        "total_escorts": await db.escort_sessions.count_documents({}),
    }

# ================== ADMIN REPORTS ==================
@api_router.get("/admin/all-reports")
async def admin_all_reports(user=Depends(get_admin_user), limit: int = Query(100)):
    cursor = db.civil_reports.find({}).sort("created_at", -1).limit(limit)
    reports = []
    async for r in cursor:
        # Look up the submitting user's profile photo for display in report cards
        user_photo_url = None
        if r.get("user_id"):
            try:
                u = await db.users.find_one({"_id": ObjectId(r["user_id"])}, {"photo_url": 1})
                user_photo_url = u.get("photo_url") if u else None
            except Exception:
                pass
        reports.append({
            "id":             str(r["_id"]),
            "user_id":        r.get("user_id"),
            "user_name":      r.get("user_name"),
            "user_email":     r.get("user_email"),
            "user_phone":     r.get("user_phone"),
            "user_photo_url": user_photo_url,
            "type":           r.get("type", "video"),
            "caption":        r.get("caption"),
            "file_url":       r.get("file_url"),
            "status":         r.get("status", "pending"),
            "is_anonymous":   r.get("is_anonymous", False),
            "latitude":       r.get("latitude"),
            "longitude":      r.get("longitude"),
            "location":       r.get("location"),
            "created_at":     r["created_at"].isoformat() if isinstance(r.get("created_at"), datetime) else r.get("created_at"),
        })
    return {"reports": reports}

@api_router.delete("/admin/delete/{item_type}/{item_id}")
async def admin_delete_item(item_type: str, item_id: str, user=Depends(get_admin_user)):
    collection_map = {
        "report": "civil_reports",
        "panic":  "panic_events",
        "escort": "escort_sessions",
        "user":   "users",
    }
    col = collection_map.get(item_type)
    if not col:
        raise HTTPException(status_code=400, detail="Unknown type")
    await db[col].delete_one({"_id": ObjectId(item_id)})
    # FIX #4: Log deletions so they appear in the audit trail.
    await _log_admin_action(str(user["_id"]), f"delete_{item_type}", item_type, item_id, {})
    return {"ok": True}

# ================== ADMIN MAINTENANCE ==================
@api_router.post("/admin/clear-panics")
async def admin_clear_panics(user=Depends(get_admin_user)):
    result = await db.panic_events.update_many({"is_active": True}, {"$set": {"is_active": False, "deactivated_at": datetime.utcnow()}})
    # FIX #4: Log this maintenance action.
    await _log_admin_action(str(user["_id"]), "clear_panics", "panic_events", "all", {"cleared": result.modified_count})
    return {"ok": True, "cleared": result.modified_count}

@api_router.post("/admin/resolve-trapped-panics")
async def admin_resolve_trapped(user=Depends(get_admin_user)):
    cutoff = datetime.utcnow() - timedelta(hours=6)
    result = await db.panic_events.update_many(
        {"is_active": True, "activated_at": {"$lt": cutoff}},
        {"$set": {"is_active": False, "deactivated_at": datetime.utcnow()}}
    )
    await _log_admin_action(str(user["_id"]), "resolve_trapped_panics", "panic_events", "all", {"resolved": result.modified_count})
    return {"ok": True, "resolved": result.modified_count}

@api_router.post("/admin/clear-trapped-escorts")
async def admin_clear_escorts(user=Depends(get_admin_user)):
    cutoff = datetime.utcnow() - timedelta(hours=12)
    result = await db.escort_sessions.update_many(
        {"is_active": True, "started_at": {"$lt": cutoff}},
        {"$set": {"is_active": False, "ended_at": datetime.utcnow()}}
    )
    await _log_admin_action(str(user["_id"]), "clear_trapped_escorts", "escort_sessions", "all", {"cleared": result.modified_count})
    return {"ok": True, "cleared": result.modified_count}

@api_router.post("/admin/clear-uploads")
async def admin_clear_uploads(user=Depends(get_admin_user)):
    result = await db.civil_reports.delete_many({"type": "video"})
    await _log_admin_action(str(user["_id"]), "clear_uploads", "civil_reports", "all", {"deleted": result.deleted_count})
    return {"ok": True, "deleted": result.deleted_count}

@api_router.post("/admin/reset-all-data")
async def admin_reset_all(user=Depends(get_admin_user)):
    await db.panic_events.delete_many({})
    await db.escort_sessions.delete_many({})
    await db.civil_reports.delete_many({})
    await db.admin_logs.delete_many({})
    # Note: we log BEFORE clearing so this entry survives
    await _log_admin_action(str(user["_id"]), "reset_all_data", "all", "all", {})
    return {"ok": True}

# ================== ADMIN SEARCH ==================
@api_router.get("/admin/search")
async def admin_search(
    query: str = Query(...),
    data_type: str = Query("users"),
    role: Optional[str] = Query(None, description="Filter by role: civil, security, or admin"),
    user=Depends(get_admin_user)
):
    results = []
    regex = {"$regex": query, "$options": "i"}
    if data_type in ("users", "all"):
        # Build user query with optional role filter
        user_query: Dict[str, Any] = {
            "$and": [
                {"$or": [{"email": regex}, {"full_name": regex}, {"phone": regex}]}
            ]
        }
        # Add role filter if specified
        if role:
            user_query["$and"].append({"role": role})

        cursor = db.users.find(user_query).limit(50)
        async for u in cursor:
            results.append({
                "type":      "user",
                "data_type": "user",
                "id":        str(u["_id"]),
                "email":     u.get("email"),
                "full_name": u.get("full_name"),
                "phone":     u.get("phone"),
                "role":      u.get("role"),
                "is_active": u.get("is_active", True),
                "created_at": u.get("created_at").isoformat() if isinstance(u.get("created_at"), datetime) else None,
            })
    return {"results": results}

# ================== ADMIN TRACK USER ==================
@api_router.get("/admin/track-user/{user_id}")
async def admin_track_user(user_id: str, user=Depends(get_admin_user)):
    panic = await db.panic_events.find_one({"user_id": user_id, "is_active": True})
    escort = await db.escort_sessions.find_one({"user_id": user_id, "is_active": True})
    location_history = []
    latitude, longitude, is_active = None, None, False

    if panic:
        location_history = panic.get("location_history", [])
        current = panic.get("current_location", {})
        latitude  = current.get("latitude")
        longitude = current.get("longitude")
        is_active = True
    elif escort:
        location_history = escort.get("route", [])
        if location_history:
            latest = location_history[-1]
            latitude  = latest.get("latitude")
            longitude = latest.get("longitude")
        is_active = True

    return {
        "is_active":        is_active,
        "latitude":         latitude,
        "longitude":        longitude,
        "location_history": location_history[-90:],
    }

# ================== ADMIN MESSAGE ==================
@api_router.post("/admin/message")
async def admin_send_message(body: dict = Body(...), user=Depends(get_admin_user)):
    await db.messages.insert_one({
        "from_admin": True,
        "admin_id":   str(user["_id"]),
        "to_user_id": body.get("user_id"),
        "message":    body.get("message"),
        "sent_at":    datetime.utcnow(),
    })
    await _log_admin_action(str(user["_id"]), "send_message", "user", body.get("user_id", ""), {"message_preview": str(body.get("message", ""))[:80]})
    return {"ok": True}

# ================== REPORTS ==================
@api_router.post("/report/upload-audio")
async def upload_audio_report(request: Request, user=Depends(get_current_user)):
    try:
        form = await request.form()
        audio_file = form.get("audio")
        if not audio_file:
            raise HTTPException(status_code=400, detail="No audio file")
        audio_bytes = await audio_file.read()
        if not cloudinary_service:
            raise HTTPException(status_code=503, detail="Audio storage service unavailable")

        file_url = await cloudinary_service.upload_file(
            audio_bytes, f"audio_{uuid.uuid4().hex}.m4a", "audio/m4a", folder="audio_reports"
        )
        if not file_url:
            raise HTTPException(status_code=500, detail="Audio upload failed — check Cloudinary credentials")
        return {"ok": True, "file_url": file_url}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@api_router.post("/report/create")
async def create_report(body: dict = Body(...), user=Depends(get_current_user)):
    doc = {
        "user_id":     str(user["_id"]),
        "user_email":  user.get("email"),
        "user_name":   user.get("full_name") or user.get("email"),
        "user_phone":  user.get("phone"),
        "type":        body.get("type", "audio"),
        "caption":     body.get("caption", ""),
        "file_url":    body.get("file_url"),
        "is_anonymous":body.get("is_anonymous", False),
        "latitude":    body.get("latitude"),
        "longitude":   body.get("longitude"),
        "status":      "pending",
        "created_at":  datetime.utcnow(),
    }
    result = await db.civil_reports.insert_one(doc)
    return {"ok": True, "report_id": str(result.inserted_id)}

@api_router.get("/report/my-reports")
async def my_reports(user=Depends(get_current_user)):
    cursor = db.civil_reports.find({"user_id": str(user["_id"])}).sort("created_at", -1).limit(50)
    reports = []
    async for r in cursor:
        reports.append({
            "id":         str(r["_id"]),
            "type":       r.get("type"),
            "caption":    r.get("caption"),
            "file_url":   r.get("file_url"),
            "status":     r.get("status", "pending"),
            "created_at": r["created_at"].isoformat() if isinstance(r.get("created_at"), datetime) else r.get("created_at"),
        })
    return {"reports": reports}

# ================== PAYMENT / PREMIUM ==================
@api_router.post("/payment/verify")
async def verify_payment(body: dict = Body(...), user=Depends(get_current_user)):
    await db.users.update_one({"_id": user["_id"]}, {"$set": {"is_premium": True}})
    return {"ok": True, "is_premium": True, "message": "Premium activated"}

# ================== SECURITY EXTRAS ==================
@api_router.post("/security/team-location")
async def update_team_location(body: dict = Body(...), user=Depends(get_current_user)):
    if user.get("role") not in ("security", "admin"):
        raise HTTPException(status_code=403, detail="Security only")
    await db.users.update_one(
        {"_id": user["_id"]},
        {"$set": {
            "team_location": {"latitude": body.get("latitude"), "longitude": body.get("longitude")},
            "radius_km":     body.get("radius_km", 10),
            "location_updated_at": datetime.utcnow(),
        }}
    )
    u = await db.users.find_one({"_id": user["_id"]})
    return {
        "latitude":  body.get("latitude"),
        "longitude": body.get("longitude"),
        "radius_km": u.get("radius_km", 10),
    }

@api_router.get("/security/team-location")
async def get_team_location(user=Depends(get_current_user)):
    if user.get("role") not in ("security", "admin"):
        raise HTTPException(status_code=403, detail="Security only")
    loc = user.get("team_location", {})
    return {
        "latitude":  loc.get("latitude"),
        "longitude": loc.get("longitude"),
        "radius_km": user.get("radius_km", 10),
    }

@api_router.get("/security/nearby-reports")
async def security_nearby_reports(user=Depends(get_current_user)):
    if user.get("role") not in ("security", "admin"):
        raise HTTPException(status_code=403, detail="Security only")
    cursor = db.civil_reports.find({
        "$or": [{"status": "pending"}, {"status": {"$exists": False}}]
    }).sort("created_at", -1).limit(50)
    reports = []
    async for r in cursor:
        user_photo_url = None
        if r.get("user_id"):
            try:
                u = await db.users.find_one({"_id": ObjectId(r["user_id"])}, {"photo_url": 1})
                user_photo_url = u.get("photo_url") if u else None
            except Exception:
                pass
        reports.append({
            "id":             str(r["_id"]),
            "user_id":        r.get("user_id"),
            "user_name":      r.get("user_name"),
            "user_email":     r.get("user_email"),
            "user_photo_url": user_photo_url,
            "type":           r.get("type"),
            "caption":        r.get("caption"),
            "file_url":       r.get("file_url"),
            "latitude":       r.get("latitude"),
            "longitude":      r.get("longitude"),
            "created_at":     r["created_at"].isoformat() if isinstance(r.get("created_at"), datetime) else r.get("created_at"),
        })
    return reports

@api_router.get("/security/search-user")
async def security_search_user(query: str = Query(...), user=Depends(get_current_user)):
    if user.get("role") not in ("security", "admin"):
        raise HTTPException(status_code=403, detail="Security only")
    regex = {"$regex": query, "$options": "i"}
    u = await db.users.find_one({"$or": [{"email": regex}, {"full_name": regex}, {"phone": regex}], "role": "civil"})
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    return {
        "user_id":   str(u["_id"]),
        "email":     u.get("email"),
        "full_name": u.get("full_name"),
        "phone":     u.get("phone"),
        "role":      u.get("role"),
    }

@api_router.post("/security/ping-user/{uid}")
async def security_ping_user(uid: str, user=Depends(get_current_user)):
    if user.get("role") not in ("security", "admin"):
        raise HTTPException(status_code=403, detail="Security only")
    target = await db.users.find_one({"_id": ObjectId(uid)})
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if expo_push_service and target.get("push_token"):
        await expo_push_service.send_push_notification(
            token=target["push_token"],
            title="📍 Security Check-In",
            body=f"Security officer {user.get('full_name', '')} is checking on you",
            data={"type": "ping"}
        )
    return {"ok": True}


# ── Ping all security agents (admin OR security role) ──────────────────────────
# Sends a silent push to every active security user's device.
# Each device's notification handler should call POST /security/update-location
# with fresh GPS, making the security-map and nearby views current on next fetch.
@api_router.post("/admin/ping-all-security")
async def ping_all_security(user=Depends(get_current_user)):
    if user.get("role") not in ("admin", "security"):
        raise HTTPException(status_code=403, detail="Admin or security only")

    cursor = db.users.find({"role": "security", "is_active": True})
    pinged = 0
    failed = 0
    requester_name = user.get("full_name") or user.get("email") or "Operations"

    async for agent in cursor:
        push_token = agent.get("push_token")
        if not push_token:
            failed += 1
            continue
        try:
            if expo_push_service:
                await expo_push_service.send_push_notification(
                    token=push_token,
                    title="📍 Location Request",
                    body=f"{requester_name} requests your current location",
                    data={"type": "location_ping"},   # handled by app background handler
                )
            pinged += 1
        except Exception:
            failed += 1

    return {"ok": True, "pinged": pinged, "failed": failed}

# ================== CHAT ==================
@api_router.get("/chat/conversations")
async def get_conversations(user=Depends(get_current_user)):
    uid = str(user["_id"])
    cursor = db.chat_conversations.find({"participants": uid}).sort("last_message_at", -1).limit(50)
    convs = []
    async for c in cursor:
        other_id = next((p for p in c.get("participants", []) if p != uid), None)
        other_user_obj = None
        if other_id:
            try:
                ou = await db.users.find_one({"_id": ObjectId(other_id)})
                if ou:
                    other_user_obj = {
                        "id":                str(ou["_id"]),
                        "full_name":         ou.get("full_name") or ou.get("email"),
                        "role":              ou.get("role"),
                        "status":            ou.get("status", "available"),
                        "security_sub_role": ou.get("security_sub_role"),
                    }
            except Exception:
                pass

        convs.append({
            "id":              str(c["_id"]),
            "participants":    c.get("participants", []),
            "other_user":      other_user_obj,
            "last_message":    c.get("last_message"),
            "last_message_at": c["last_message_at"].isoformat() if isinstance(c.get("last_message_at"), datetime) else c.get("last_message_at"),
            "unread":          c.get(f"unread_{uid}", 0),
            "unread_count":    c.get(f"unread_{uid}", 0),
        })
    return {"conversations": convs}

@api_router.post("/chat/start")
async def start_conversation(body: dict = Body(...), user=Depends(get_current_user)):
    uid = str(user["_id"])
    # Accept both "to_user_id" (frontend) and legacy "user_id"
    other_id = body.get("to_user_id") or body.get("user_id")
    if not other_id:
        raise HTTPException(status_code=400, detail="to_user_id is required")
    existing = await db.chat_conversations.find_one({"participants": {"$all": [uid, other_id]}})
    if existing:
        return {"conversation_id": str(existing["_id"]), "existing": True}
    result = await db.chat_conversations.insert_one({
        "participants":    [uid, other_id],
        "last_message":    None,
        "last_message_at": datetime.utcnow(),
    })
    return {"conversation_id": str(result.inserted_id), "existing": False}

@api_router.get("/chat/{conv_id}/messages")
async def get_messages(conv_id: str, user=Depends(get_current_user)):
    uid = str(user["_id"])
    cursor = db.chat_messages.find({"conversation_id": conv_id}).sort("sent_at", 1).limit(200)
    messages = []
    async for m in cursor:
        # Normalise: stored as "message" legacy, or "content" new — expose both
        text = m.get("content") or m.get("message") or ""
        sent = m.get("sent_at")
        sent_str = sent.isoformat() if isinstance(sent, datetime) else (sent or "")
        messages.append({
            "id":           str(m["_id"]),
            "from_user_id": m.get("from_user_id"),
            "content":      text,
            "message":      text,
            "created_at":   sent_str,
            "sent_at":      sent_str,
            "is_mine":      m.get("from_user_id") == uid,
        })
    return {"messages": messages}

@api_router.post("/chat/send")
async def send_message(body: dict = Body(...), user=Depends(get_current_user)):
    uid  = str(user["_id"])
    now  = datetime.utcnow()

    # Support both call patterns:
    #   NEW  → { to_user_id, content, message_type }   (frontend sends this)
    #   LEGACY → { conversation_id, message }
    to_user_id = body.get("to_user_id")
    conv_id    = body.get("conversation_id")
    content    = body.get("content") or body.get("message") or ""

    # Resolve conv_id from to_user_id when not supplied directly
    if not conv_id and to_user_id:
        existing = await db.chat_conversations.find_one({"participants": {"$all": [uid, to_user_id]}})
        if existing:
            conv_id = str(existing["_id"])
        else:
            ins = await db.chat_conversations.insert_one({
                "participants":    [uid, to_user_id],
                "last_message":    None,
                "last_message_at": now,
            })
            conv_id = str(ins.inserted_id)

    if not conv_id:
        raise HTTPException(status_code=400, detail="conversation_id or to_user_id required")

    await db.chat_messages.insert_one({
        "conversation_id": conv_id,
        "from_user_id":    uid,
        "content":         content,
        "message":         content,        # keep legacy field in sync
        "message_type":    body.get("message_type", "text"),
        "sent_at":         now,
    })

    conv = await db.chat_conversations.find_one({"_id": ObjectId(conv_id)})
    inc_fields: dict = {}
    if conv:
        for pid in conv.get("participants", []):
            if pid != uid:
                inc_fields[f"unread_{pid}"] = 1

    update: dict = {"$set": {"last_message": content, "last_message_at": now}}
    if inc_fields:
        update["$inc"] = inc_fields  # type: ignore[assignment]

    await db.chat_conversations.update_one({"_id": ObjectId(conv_id)}, update)
    return {"ok": True, "conversation_id": conv_id}

@api_router.post("/chat/mark-read")
async def mark_conversation_read(body: dict = Body(...), user=Depends(get_current_user)):
    uid = str(user["_id"])
    conv_id = body.get("conversation_id")
    await db.chat_conversations.update_one(
        {"_id": ObjectId(conv_id)},
        {"$set": {f"unread_{uid}": 0}}
    )
    return {"ok": True}

# ================== AUDIT LOG ==================
@api_router.get("/admin/audit-log")
async def admin_audit_log(
    user=Depends(get_admin_user),
    skip: int = Query(0),
    limit: int = Query(30)
):
    """Paginated admin action log.
    
    FIX #4: Enrich each log entry with the admin's name and email (resolved from
    the users collection) and map the stored `target` field → `target_type` so
    the frontend renderLog() can display it.  Previously the response only
    included `admin_id` and `target`, causing the frontend to show blank admin
    name and blank target_type for every entry.
    """
    total = await db.admin_logs.count_documents({})
    cursor = db.admin_logs.find({}).sort("timestamp", -1).skip(skip).limit(limit)
    logs = []

    async for log in cursor:
        ts = log.get("timestamp")

        # Resolve admin user details for display
        admin_name  = "Admin"
        admin_email = ""
        raw_admin_id = log.get("admin_id", "")
        if raw_admin_id:
            try:
                admin_doc = await db.users.find_one({"_id": ObjectId(raw_admin_id)})
                if admin_doc:
                    admin_name  = admin_doc.get("full_name") or admin_doc.get("email") or "Admin"
                    admin_email = admin_doc.get("email") or ""
            except Exception:
                pass

        logs.append({
            "id":          str(log["_id"]),
            "admin_id":    raw_admin_id,
            "admin_name":  admin_name,
            "admin_email": admin_email,
            "action":      log.get("action"),
            # `target` in DB → `target_type` for the frontend
            "target_type": log.get("target"),
            "target":      log.get("target"),
            "target_id":   log.get("target_id"),
            "details":     log.get("details", {}),
            "timestamp":   ts.isoformat() if isinstance(ts, datetime) else ts,
        })

    return {"logs": logs, "total": total}

# ================== BROADCAST ==================
@api_router.post("/admin/broadcast")
async def admin_broadcast(body: dict = Body(...), user=Depends(get_admin_user)):
    """Send a push broadcast to all users of a target role."""
    title       = body.get("title", "Notification")
    message     = body.get("message", "")
    target_role = body.get("target_role", "all")

    query: dict = {}
    if target_role in ("civil", "security"):
        query["role"] = target_role

    await db.broadcasts.insert_one({
        "title":       title,
        "message":     message,
        "target_role": target_role,
        "sent_by":     str(user["_id"]),
        "sent_at":     datetime.utcnow(),
    })

    recipients = 0
    if expo_push_service:
        users_cursor = db.users.find({**query, "push_token": {"$exists": True, "$ne": None}})
        async for u in users_cursor:
            try:
                await expo_push_service.send_push_notification(
                    token=u["push_token"], title=title, body=message,
                    data={"type": "broadcast"}
                )
                recipients += 1
            except Exception as e:
                logger.error(f"Broadcast push error: {e}")

    await _log_admin_action(str(user["_id"]), "broadcast", "all", "all",
                            {"title": title, "target_role": target_role, "recipients": recipients})
    return {"ok": True, "recipients": recipients}

@api_router.get("/broadcasts")
async def get_broadcasts(user=Depends(get_current_user)):
    """Civil/security users fetch broadcasts addressed to them."""
    role = user.get("role", "civil")
    query = {"$or": [{"target_role": "all"}, {"target_role": role}]}
    cursor = db.broadcasts.find(query).sort("sent_at", -1).limit(50)
    broadcasts = []
    async for b in cursor:
        sent = b.get("sent_at")
        broadcasts.append({
            "id":          str(b["_id"]),
            "title":       b.get("title"),
            "message":     b.get("message"),
            "target_role": b.get("target_role"),
            "sent_at":     sent.isoformat() if isinstance(sent, datetime) else sent,
        })
    return {"broadcasts": broadcasts}

# ================== SECURITY TEAMS (ADMIN) ==================
@api_router.get("/admin/security-teams")
async def admin_security_teams(user=Depends(get_admin_user)):
    teams_cursor = db.security_teams.find({})
    teams = []
    async for t in teams_cursor:
        members_cursor = db.users.find({"team_name": t.get("name"), "role": "security"})
        members = []
        async for m in members_cursor:
            members.append({
                "id":        str(m["_id"]),
                "email":     m.get("email"),
                "full_name": m.get("full_name"),
                "sub_role":  m.get("security_sub_role"),
                "status":    m.get("status", "available"),
            })
        created = t.get("created_at")
        teams.append({
            "id":         str(t["_id"]),
            "name":       t.get("name"),
            "created_at": created.isoformat() if isinstance(created, datetime) else created,
            "members":    members,
        })

    ungrouped_cursor = db.users.find({"role": "security", "team_name": None})
    ungrouped = []
    async for u in ungrouped_cursor:
        ungrouped.append({
            "id":        str(u["_id"]),
            "email":     u.get("email"),
            "full_name": u.get("full_name"),
            "sub_role":  u.get("security_sub_role"),
            "status":    u.get("status", "available"),
        })
    if ungrouped:
        teams.append({"id": "ungrouped", "name": "Unassigned", "members": ungrouped})

    return teams

@api_router.post("/admin/create-team")
async def admin_create_team(body: dict = Body(...), user=Depends(get_admin_user)):
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Team name required")
    existing = await db.security_teams.find_one({"name": name})
    if existing:
        raise HTTPException(status_code=400, detail="Team already exists")
    result = await db.security_teams.insert_one({
        "name":       name,
        "created_at": datetime.utcnow(),
        "created_by": str(user["_id"]),
    })
    await _log_admin_action(str(user["_id"]), "create_team", "security_team", str(result.inserted_id), {"name": name})
    return {"ok": True, "team_id": str(result.inserted_id), "name": name}

# ================== SECURITY MAP (ADMIN) ==================
@api_router.get("/admin/security-map")
async def admin_security_map(user=Depends(get_admin_user)):
    cursor = db.users.find({"role": "security"})
    security_users = []
    async for u in cursor:
        # Prefer live current_location (from update-location / ping response) over
        # the static team_location that the officer set manually.
        loc = u.get("current_location") or u.get("team_location") or {}
        lat = loc.get("latitude")
        lng = loc.get("longitude")
        coords = [lng, lat] if lat is not None and lng is not None else None
        security_users.append({
            "id":        str(u["_id"]),
            "email":     u.get("email"),
            "full_name": u.get("full_name"),
            "status":    u.get("status", "available"),
            "is_active": u.get("is_active", True),
            "team_name": u.get("team_name"),
            "location":  {"coordinates": coords} if coords else None,
            "latitude":  lat,
            "longitude": lng,
            "radius_km": u.get("radius_km", 10),
            "updated_at": u.get("location_updated_at", u.get("created_at", "")).isoformat()
                          if isinstance(u.get("location_updated_at") or u.get("created_at"), datetime)
                          else None,
            "security_sub_role": u.get("security_sub_role"),
            "phone": u.get("phone"),
        })
    return {"security_users": security_users}

# ================== SECURITY PROFILE & SETTINGS ==================
@api_router.get("/security/profile")
async def security_profile(user=Depends(get_current_user)):
    if user.get("role") not in ("security", "admin"):
        raise HTTPException(status_code=403, detail="Security only")
    loc = user.get("team_location", {}) or {}
    return {
        "user_id":               str(user["_id"]),
        "email":                 user.get("email"),
        "full_name":             user.get("full_name"),
        "phone":                 user.get("phone"),
        "team_name":             user.get("team_name"),
        "security_sub_role":     user.get("security_sub_role"),
        "status":                user.get("status", "available"),
        "is_visible":            user.get("is_visible", True),
        "visibility_radius_km":  user.get("visibility_radius_km", user.get("radius_km", 25)),
        "latitude":              loc.get("latitude"),
        "longitude":             loc.get("longitude"),
    }

@api_router.put("/security/settings")
async def security_save_settings(body: dict = Body(...), user=Depends(get_current_user)):
    if user.get("role") not in ("security", "admin"):
        raise HTTPException(status_code=403, detail="Security only")
    await db.users.update_one(
        {"_id": user["_id"]},
        {"$set": {
            "visibility_radius_km": body.get("visibility_radius_km", 25),
            "is_visible":           body.get("is_visible", True),
            "status":               body.get("status", "available"),
        }}
    )
    return {"ok": True}

@api_router.put("/security/status")
async def security_update_status(body: dict = Body(...), user=Depends(get_current_user)):
    if user.get("role") not in ("security", "admin"):
        raise HTTPException(status_code=403, detail="Security only")
    status = body.get("status", "available")
    await db.users.update_one({"_id": user["_id"]}, {"$set": {"status": status}})
    return {"ok": True, "status": status}

# ================== SECURITY LOCATION (aliases) ==================
@api_router.post("/security/set-location")
async def security_set_location(body: dict = Body(...), user=Depends(get_current_user)):
    if user.get("role") not in ("security", "admin"):
        raise HTTPException(status_code=403, detail="Security only")
    await db.users.update_one(
        {"_id": user["_id"]},
        {"$set": {
            "team_location":        {"latitude": body.get("latitude"), "longitude": body.get("longitude")},
            "radius_km":            body.get("radius_km", 10),
            "location_updated_at":  datetime.utcnow(),
        }}
    )
    return {"ok": True, "latitude": body.get("latitude"), "longitude": body.get("longitude"),
            "radius_km": body.get("radius_km", 10)}

@api_router.post("/security/update-location")
async def security_update_location(body: dict = Body(...), user=Depends(get_current_user)):
    if user.get("role") not in ("security", "admin"):
        raise HTTPException(status_code=403, detail="Security only")
    await db.users.update_one(
        {"_id": user["_id"]},
        {"$set": {
            "current_location": {
                "latitude":  body.get("latitude"),
                "longitude": body.get("longitude"),
                "accuracy":  body.get("accuracy"),
                "timestamp": datetime.utcnow().isoformat(),
            },
            "location_updated_at": datetime.utcnow(),
        }}
    )
    return {"ok": True}

# ================== SECURITY NEARBY ==================
@api_router.get("/security/nearby")
async def security_nearby(user=Depends(get_current_user)):
    if user.get("role") not in ("security", "admin"):
        raise HTTPException(status_code=403, detail="Security only")

    panics_cursor = db.panic_events.find({"is_active": True}).sort("activated_at", -1).limit(50)
    panics = []
    async for p in panics_cursor:
        loc = p.get("current_location", {})
        panics.append({
            "id":                 str(p["_id"]),
            "type":               "panic",
            "user_name":          p.get("user_name"),
            "emergency_category": p.get("emergency_category", "other"),
            "latitude":           loc.get("latitude"),
            "longitude":          loc.get("longitude"),
            "activated_at":       p.get("activated_at").isoformat() if p.get("activated_at") else None,
        })

    reports_cursor = db.civil_reports.find({"status": "pending"}).sort("created_at", -1).limit(50)
    reports = []
    async for r in reports_cursor:
        created = r.get("created_at")
        reports.append({
            "id":         str(r["_id"]),
            "type":       "report",
            "user_name":  r.get("user_name"),
            "caption":    r.get("caption"),
            "latitude":   r.get("latitude"),
            "longitude":  r.get("longitude"),
            "created_at": created.isoformat() if isinstance(created, datetime) else created,
        })

    return {"panics": panics, "reports": reports}

@api_router.get("/security/nearby-security")
async def security_nearby_security(user=Depends(get_current_user)):
    if user.get("role") not in ("security", "admin", "civil"):
        raise HTTPException(status_code=403, detail="Not authorized")
    cursor = db.users.find({"role": "security", "is_visible": {"$ne": False}, "is_active": True})
    agents = []
    async for u in cursor:
        # Prefer live current_location (set by update-location), fall back to saved team_location
        loc = u.get("current_location") or u.get("team_location") or {}
        lat = loc.get("latitude")
        lng = loc.get("longitude")
        agents.append({
            "id":               str(u["_id"]),
            "full_name":        u.get("full_name"),
            "status":           u.get("status", "available"),
            "security_sub_role": u.get("security_sub_role"),
            "team_name":        u.get("team_name"),
            "latitude":         lat,
            "longitude":        lng,
            # GeoJSON-style location so frontend map markers work with coordinates[0/1]
            "location": {"coordinates": [lng, lat]} if lat is not None and lng is not None else None,
        })
    return {"agents": agents}

# ================== SECURITY TRACK USER ==================
@api_router.get("/security/track-user/{uid}")
async def security_track_user(uid: str, user=Depends(get_current_user)):
    if user.get("role") not in ("security", "admin"):
        raise HTTPException(status_code=403, detail="Security or admin only")

    panic = await db.panic_events.find_one({"user_id": uid, "is_active": True})
    escort = await db.escort_sessions.find_one({"user_id": uid, "is_active": True})

    # Also check civil_tracks for ping-response locations (works even without panic/escort)
    civil_track = await db.civil_tracks.find_one({"user_id": uid})

    location_history = []
    latitude, longitude, is_active = None, None, False

    if panic:
        location_history = panic.get("location_history", [])
        current = panic.get("current_location", {})
        latitude  = current.get("latitude")
        longitude = current.get("longitude")
        is_active = True
    elif escort:
        location_history = escort.get("route", [])
        if location_history:
            latest = location_history[-1]
            latitude  = latest.get("latitude")
            longitude = latest.get("longitude")
        is_active = True
    elif civil_track:
        # User was pinged but has no active panic/escort — show ping-response location
        current_loc = civil_track.get("currentLocation", {})
        if current_loc and "coordinates" in current_loc:
            longitude = current_loc["coordinates"][0] if len(current_loc["coordinates"]) > 0 else None
            latitude  = current_loc["coordinates"][1] if len(current_loc["coordinates"]) > 1 else None
        location_history = civil_track.get("location_history", [])
        is_active = True  # Track is active = user can be pinged

    return {
        "is_active":        is_active,
        "latitude":         latitude,
        "longitude":        longitude,
        "location_history": location_history[-90:],
    }

# ================== CHAT UNREAD COUNT ==================
@api_router.get("/chat/unread-count")
async def chat_unread_count(user=Depends(get_current_user)):
    uid = str(user["_id"])
    cursor = db.chat_conversations.find({"participants": uid})
    total_unread = 0
    async for c in cursor:
        total_unread += c.get(f"unread_{uid}", 0)
    return {"count": total_unread}

# ================== USER PROFILE PHOTO ==================
@api_router.post("/user/profile-photo-base64")
async def upload_profile_photo(body: dict = Body(...), user=Depends(get_current_user)):
    photo_b64 = body.get("photo_base64", "")
    mime_type  = body.get("mime_type", "image/jpeg")
    if not photo_b64:
        raise HTTPException(status_code=400, detail="photo_base64 required")

    photo_url = ""
    if cloudinary_service:
        try:
            photo_bytes = __import__("base64").b64decode(photo_b64)
            photo_url = await cloudinary_service.upload_file(
                photo_bytes,
                f"profile_{uuid.uuid4().hex}.jpg",
                mime_type,
                folder="profiles"
            )
        except Exception as e:
            logger.error(f"Profile photo upload error: {e}")
            raise HTTPException(status_code=500, detail="Photo upload failed")
    else:
        photo_url = f"data:{mime_type};base64,{photo_b64[:50]}..."

    await db.users.update_one({"_id": user["_id"]}, {"$set": {"photo_url": photo_url}})
    return {"ok": True, "photo_url": photo_url}

# ================== USER EMERGENCY CONTACTS ==================
@api_router.get("/user/emergency-contacts")
async def get_emergency_contacts(user=Depends(get_current_user)):
    contacts = user.get("emergency_contacts", [])
    return {"contacts": contacts}

@api_router.put("/user/emergency-contacts")
async def save_emergency_contacts(body: dict = Body(...), user=Depends(get_current_user)):
    contacts = body.get("contacts", [])
    await db.users.update_one(
        {"_id": user["_id"]},
        {"$set": {"emergency_contacts": contacts}}
    )
    return {"ok": True, "contacts": contacts}

# ================== USER APP CUSTOMIZATION ==================
@api_router.put("/user/customize-app")
async def customize_app(body: dict = Body(...), user=Depends(get_current_user)):
    await db.users.update_one(
        {"_id": user["_id"]},
        {"$set": {
            "app_customization": {
                "app_name": body.get("app_name", "Se-Q"),
                "app_logo": body.get("app_logo", ""),
            }
        }}
    )
    return {"ok": True}

# ================== CONTACTABLE USERS ==================
@api_router.get("/users/contactable")
async def get_contactable_users(user=Depends(get_current_user)):
    uid = str(user["_id"])
    role = user.get("role", "civil")

    if role == "civil":
        query = {"role": "security", "is_active": True, "is_visible": {"$ne": False}}
    else:
        query = {"role": "civil", "is_active": True, "_id": {"$ne": user["_id"]}}

    cursor = db.users.find(query).limit(100)
    users = []
    async for u in cursor:
        users.append({
            "id":        str(u["_id"]),
            "full_name": u.get("full_name") or u.get("email"),
            "email":     u.get("email"),
            "phone":     u.get("phone"),
            "role":      u.get("role"),
        })
    return {"users": users}

# CORS Configuration
# Restrict to specific origins for production security
ALLOWED_ORIGINS = os.environ.get(
    'ALLOWED_ORIGINS',
    'se-q-app.com,your-app.expo.dev,*.expo.dev,*.expo.io,se-q-production.up.railway.app,*.up.railway.app'
).split(',')

app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Requested-With"],
)
