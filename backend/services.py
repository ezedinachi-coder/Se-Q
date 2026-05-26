"""
Integration services — Cloudinary for persistent file storage.
Cloudinary replaces the local-disk mock so that uploaded files
survive Railway redeploys (Railway has an ephemeral filesystem).

Required env vars (recommended):
    CLOUDINARY_URL          ← Best: cloudinary://api_key:api_secret@cloud_name
Or individually:
    CLOUDINARY_CLOUD_NAME
    CLOUDINARY_API_KEY
    CLOUDINARY_API_SECRET
"""

import os
import logging
import base64
import httpx
import asyncio
import functools
from typing import List, Optional, Callable
from pathlib import Path

import cloudinary
import cloudinary.uploader

logger = logging.getLogger(__name__)

# ── Cloudinary configuration ────────────────────────────────────────────────
def configure_cloudinary():
    # Preferred method: single CLOUDINARY_URL env var (recommended by Cloudinary)
    cloudinary_url = os.getenv("CLOUDINARY_URL")
    if cloudinary_url:
        cloudinary.config(cloudinary_url=cloudinary_url, secure=True)
        # Extract cloud name for logging
        cloud_name = cloudinary_url.split("@")[-1] if "@" in cloudinary_url else "unknown"
        logger.info(f"Cloudinary configured via CLOUDINARY_URL for cloud: {cloud_name}")
        return True

    # Fallback: individual variables
    cloud_name = os.getenv("CLOUDINARY_CLOUD_NAME")
    api_key = os.getenv("CLOUDINARY_API_KEY")
    api_secret = os.getenv("CLOUDINARY_API_SECRET")

    if cloud_name and api_key and api_secret:
        cloudinary.config(
            cloud_name=cloud_name,
            api_key=api_key,
            api_secret=api_secret,
            secure=True,
        )
        logger.info(f"Cloudinary configured for cloud: {cloud_name}")
        return True
    else:
        logger.warning(
            "Cloudinary credentials not set. "
            "Add CLOUDINARY_URL (preferred) or the three individual vars: "
            "CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET"
        )
        return False


configure_cloudinary()

# ===== CLOUDINARY STORAGE SERVICE =====
class CloudinaryStorageService:
    """
    Uploads files to Cloudinary and returns permanent HTTPS URLs.
    Replaces the local-disk FirebaseStorageService mock.

    Folder mapping:
        'photos' → se-q/photos/
        'videos' → se-q/videos/
        'audio'  → se-q/audio/
    """

    def _resource_type(self, content_type: str) -> str:
        """Map MIME type to Cloudinary resource_type."""
        if content_type.startswith("video/"):
            return "video"
        if content_type.startswith("audio/") or content_type in (
            "audio/m4a", "audio/mp4", "audio/mpeg", "audio/wav",
            "audio/aac", "audio/3gpp", "audio/ogg",
        ):
            return "video"  # Cloudinary stores audio under resource_type='video'
        return "image"

    def _get_public_id(self, folder: str, filename: str) -> str:
        """Generate consistent public_id with folder structure."""
        stem = Path(filename).stem
        return f"se-q/{folder}/{stem}"

    def _run_sync(self, fn):
        """Run synchronous Cloudinary call in thread pool (non-blocking)."""
        try:
            loop = asyncio.get_running_loop()
            return loop.run_in_executor(None, fn)
        except RuntimeError:
            # Fallback if no running loop (rare)
            return asyncio.get_event_loop().run_in_executor(None, fn)

    async def upload_file(
        self,
        file_data: bytes,
        filename: str,
        content_type: str = "application/octet-stream",
        folder: str = "uploads",
    ) -> str:
        """Upload raw bytes to Cloudinary."""
        try:
            public_id = self._get_public_id(folder, filename)
            resource_type = self._resource_type(content_type)

            upload_fn = functools.partial(
                cloudinary.uploader.upload,
                file_data,
                public_id=public_id,
                resource_type=resource_type,
                overwrite=True,
                use_filename=False,
                unique_filename=False,
            )

            result = await self._run_sync(upload_fn)
            url = result.get("secure_url", "")
            logger.info(f"Cloudinary upload OK: {url}")
            return url
        except Exception as e:
            logger.error(f"Cloudinary upload error for {filename}: {e}", exc_info=True)
            return ""

    async def upload_file_from_path(
        self,
        file_path: str,
        filename: str,
        content_type: str = "application/octet-stream",
        folder: str = "uploads",
    ) -> str:
        """Upload file from disk path (memory efficient for large files)."""
        try:
            public_id = self._get_public_id(folder, filename)
            resource_type = self._resource_type(content_type)

            upload_fn = functools.partial(
                cloudinary.uploader.upload,
                file_path,
                public_id=public_id,
                resource_type=resource_type,
                overwrite=True,
                use_filename=False,
                unique_filename=False,
            )

            result = await self._run_sync(upload_fn)
            url = result.get("secure_url", "")
            logger.info(f"Cloudinary upload from path OK: {url}")
            return url
        except Exception as e:
            logger.error(f"Cloudinary upload from path error ({filename}): {e}", exc_info=True)
            return ""

    async def upload_video_direct(
        self,
        file_path: str,
        filename: str,
        folder: str = "videos",
    ) -> str:
        """
        Upload video directly to Cloudinary with automatic optimization.
        This is faster than separate transcode + upload.
        """
        try:
            public_id = self._get_public_id(folder, filename)
            
            # Use Cloudinary's built-in video optimization
            upload_fn = functools.partial(
                cloudinary.uploader.upload,
                file_path,
                public_id=public_id,
                resource_type="video",
                overwrite=True,
                use_filename=False,
                unique_filename=False,
                # Cloudinary auto-optimization parameters
                transformation=[
                    {"quality": "auto:good", "fetch_format": "auto"},
                    {"width": 640, "height": 360, "crop": "limit"},
                    {"bit_rate": "400k"},
                    {"fps": 30}
                ],
                eager=[
                    {"streaming_profile": "mobile_hd", "format": "m3u8"},
                    {"width": 480, "height": 360, "crop": "limit", "quality": "auto"}
                ],
                eager_async=False,  # Wait for eager transformations
                chunk_size=6000000,  # 6MB chunks for faster upload
                timeout=120  # 2 minute timeout
            )
            
            result = await self._run_sync(upload_fn)
            url = result.get("secure_url", "")
            
            # Also store the streaming URL for better playback
            playback_url = result.get("playback_url", "")
            logger.info(f"Video uploaded to Cloudinary: {url}")
            if playback_url:
                logger.info(f"HLS streaming URL: {playback_url}")
            
            return url
        except Exception as e:
            logger.error(f"Cloudinary direct video upload error: {e}", exc_info=True)
            return ""

    async def upload_video_with_progress(
        self,
        file_path: str,
        filename: str,
        folder: str = "videos",
        progress_callback: Optional[Callable[[int], None]] = None,
    ) -> str:
        """
        Upload video with progress tracking for better UX.
        """
        try:
            public_id = self._get_public_id(folder, filename)
            
            # Define progress callback for Cloudinary
            def progress(completed, total):
                if progress_callback:
                    percent = int((completed / total) * 100)
                    progress_callback(percent)
            
            upload_fn = functools.partial(
                cloudinary.uploader.upload,
                file_path,
                public_id=public_id,
                resource_type="video",
                overwrite=True,
                use_filename=False,
                unique_filename=False,
                transformation=[
                    {"quality": "auto:good", "fetch_format": "auto"},
                    {"width": 640, "height": 360, "crop": "limit"},
                    {"bit_rate": "400k"}
                ],
                eager=[
                    {"streaming_profile": "mobile_hd", "format": "m3u8"}
                ],
                eager_async=False,
                chunk_size=6000000,
                timeout=120
            )
            
            result = await self._run_sync(upload_fn)
            url = result.get("secure_url", "")
            
            if progress_callback:
                progress_callback(100)
            
            return url
        except Exception as e:
            logger.error(f"Cloudinary video upload error: {e}", exc_info=True)
            return ""

    async def upload_base64(
        self,
        base64_data: str,
        filename: str,
        content_type: str,
        folder: str = "uploads",
    ) -> str:
        """Upload base64-encoded file."""
        try:
            file_data = base64.b64decode(base64_data)
            return await self.upload_file(file_data, filename, content_type, folder)
        except Exception as e:
            logger.error(f"Cloudinary base64 decode/upload error: {e}")
            return ""

    async def delete_file(self, file_url: str) -> bool:
        """Delete file from Cloudinary by its secure_url (best-effort)."""
        try:
            if not file_url or "cloudinary.com" not in file_url:
                return False

            # Robust public_id extraction from Cloudinary URL
            # Example URL: https://res.cloudinary.com/demo/image/upload/v1234567890/se-q/photos/myfile
            parts = file_url.split("/upload/")
            if len(parts) < 2:
                return False

            public_id_part = parts[1]
            # Remove version (v123...) and file extension
            if public_id_part.startswith("v"):
                public_id_part = "/".join(public_id_part.split("/")[1:])

            public_id = public_id_part.rsplit(".", 1)[0]

            # Determine resource_type from URL or content
            resource_type = "image"
            if any(x in file_url.lower() for x in ["/video/", ".mp4", ".mov", ".webm", ".avi"]):
                resource_type = "video"
            elif any(x in file_url.lower() for x in ["/audio/", ".mp3", ".wav", ".m4a", ".ogg"]):
                resource_type = "video"

            destroy_fn = functools.partial(
                cloudinary.uploader.destroy,
                public_id,
                resource_type=resource_type,
            )

            await self._run_sync(destroy_fn)
            logger.info(f"Successfully deleted from Cloudinary: {public_id} ({resource_type})")
            return True

        except Exception as e:
            logger.error(f"Cloudinary delete error for {file_url}: {e}")
            return False


# ===== Other Services =====

class PaystackService:
    """Live Paystack payment service."""
    def __init__(self):
        self.secret_key = os.getenv("PAYSTACK_SECRET_KEY", "")
        self.base_url = "https://api.paystack.co"
        if self.secret_key:
            logger.info("Paystack service initialized with live key")
        else:
            logger.warning("PAYSTACK_SECRET_KEY not set — using mock responses")

    async def initialize_transaction(self, email: str, amount: int, reference: str = None):
        """Initialize a Paystack transaction"""
        import uuid
        if not reference:
            reference = f"REF-{uuid.uuid4().hex[:12].upper()}"
        
        if not self.secret_key:
            # Mock response for development
            return {
                "status": True,
                "message": "Authorization URL created",
                "data": {
                    "authorization_url": f"https://checkout.paystack.com/{reference}",
                    "access_code": "test_access_code",
                    "reference": reference
                }
            }
        
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self.base_url}/transaction/initialize",
                json={"email": email, "amount": amount * 100, "reference": reference},
                headers={"Authorization": f"Bearer {self.secret_key}"}
            )
            return response.json()
    
    async def verify_transaction(self, reference: str):
        """Verify a Paystack transaction"""
        if not self.secret_key:
            # Mock response for development
            return {
                "status": True,
                "data": {
                    "reference": reference,
                    "status": "success",
                    "amount": 10000,
                    "customer": {"email": "test@example.com"}
                }
            }
        
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{self.base_url}/transaction/verify/{reference}",
                headers={"Authorization": f"Bearer {self.secret_key}"}
            )
            return response.json()


class ExpoPushService:
    """Expo push notification service."""
    def __init__(self):
        self.push_url = "https://exp.host/--/api/v2/push/send"
        logger.info("Expo Push service initialized")
    
    async def send_push_notification(self, token: str, title: str, body: str, data: dict = None):
        """Send a push notification via Expo"""
        import httpx
        message = {
            "to": token,
            "title": title,
            "body": body,
            "data": data or {},
            "sound": "default",
        }
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(self.push_url, json=[message])
                return response.json()
        except Exception as e:
            logger.error(f"Push notification error: {e}")
            return None


class EmailService:
    """Email service — currently logs only."""
    def __init__(self):
        self.from_email = os.getenv("FROM_EMAIL", "noreply@safeguard.app")
        logger.info("Email service initialized")
    
    async def send_email(self, to: str, subject: str, body: str):
        """Send an email (placeholder)"""
        logger.info(f"Email would be sent to {to}: {subject}")
        return True
    
    async def send_panic_alert(self, to: str, panic_data: dict):
        """Send panic alert email"""
        subject = f"🚨 PANIC ALERT - {panic_data.get('user_name', 'User')}"
        body = f"""
        Panic Alert from {panic_data.get('user_name', 'User')}
        Category: {panic_data.get('emergency_category', 'Emergency')}
        Location: {panic_data.get('current_location', {})}
        Time: {panic_data.get('activated_at')}
        """
        return await self.send_email(to, subject, body)


# ── Service singletons ──────────────────────────────────────────────────────
cloudinary_service = CloudinaryStorageService()
firebase_service = cloudinary_service  # backwards compatibility

paystack_service = PaystackService()
expo_push_service = ExpoPushService()
email_service = EmailService()
