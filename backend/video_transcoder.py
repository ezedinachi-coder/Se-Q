"""
Video Transcoding Service using FFmpeg
WhatsApp-style compression for minimal file sizes
"""

import subprocess
import os
import logging
import asyncio
from pathlib import Path
from datetime import datetime
import uuid
import shutil
from typing import Optional, Tuple
from concurrent.futures import ThreadPoolExecutor

logger = logging.getLogger(__name__)

# Thread pool for CPU-intensive transcoding
_executor = ThreadPoolExecutor(max_workers=2)


def check_ffmpeg_available() -> bool:
    """Return True if ffmpeg is installed and callable, False otherwise.

    Called during app startup so the absence of ffmpeg surfaces immediately
    rather than silently at the first video upload.
    """
    try:
        result = subprocess.run(
            ["ffmpeg", "-version"],
            capture_output=True,
            timeout=5,
        )
        if result.returncode == 0:
            logger.info("ffmpeg is available — video transcoding enabled")
            return True
        logger.warning("ffmpeg returned non-zero — transcoding may fail")
        return False
    except FileNotFoundError:
        logger.warning(
            "ffmpeg not found. Video uploads will be stored without transcoding. "
            "Install ffmpeg to enable WhatsApp-style compression."
        )
        return False
    except Exception as e:
        logger.warning(f"ffmpeg check failed: {e}")
        return False

# Transcoding profiles — WhatsApp-style compression with better quality
PROFILES = {
    'ultra_compressed': {
        'resolution': '640x360',      # 360p
        'video_bitrate': '400k',      # Increased from 200k for better quality
        'audio_bitrate': '64k',       # Better audio
        'preset': 'fast',             # Better compression than veryfast
        'crf': 28,                    # Better quality (lower is better, 18-28 is good)
        'max_file_mb': 5,
    },
    'standard': {
        'resolution': '854x480',      # 480p
        'video_bitrate': '600k',
        'audio_bitrate': '96k',
        'preset': 'fast',
        'crf': 26,
        'max_file_mb': 8,
    },
    'quality': {
        'resolution': '1280x720',     # 720p
        'video_bitrate': '1200k',
        'audio_bitrate': '128k',
        'preset': 'medium',
        'crf': 23,
        'max_file_mb': 15,
    }
}

# Default profile for emergency video reports
DEFAULT_PROFILE = 'ultra_compressed'

# Maximum duration for synchronous transcoding (seconds)
SYNC_TRANSCODE_MAX_DURATION = 120


def get_video_info(input_path: str) -> dict:
    """Get video duration, resolution, and size using FFprobe"""
    try:
        cmd = [
            'ffprobe', '-v', 'quiet',
            '-print_format', 'json',
            '-show_format', '-show_streams',
            input_path
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        
        if result.returncode != 0:
            logger.error(f"FFprobe failed: {result.stderr}")
            return {}
        
        import json
        data = json.loads(result.stdout)
        
        # Extract info
        format_info = data.get('format', {})
        video_stream = next((s for s in data.get('streams', []) if s.get('codec_type') == 'video'), {})
        
        return {
            'duration': float(format_info.get('duration', 0)),
            'size_bytes': int(format_info.get('size', 0)),
            'size_mb': int(format_info.get('size', 0)) / (1024 * 1024),
            'width': int(video_stream.get('width', 0)),
            'height': int(video_stream.get('height', 0)),
            'bitrate': int(format_info.get('bit_rate', 0)),
            'codec': video_stream.get('codec_name', 'unknown'),
        }
    except Exception as e:
        logger.error(f"Error getting video info: {e}")
        return {}


def transcode_video_sync(
    input_path: str,
    output_path: str,
    profile: str = DEFAULT_PROFILE
) -> Tuple[bool, str, dict]:
    """
    Synchronously transcode video using FFmpeg with better compression and streaming optimization
    """
    try:
        settings = PROFILES.get(profile, PROFILES[DEFAULT_PROFILE])
        
        # Get input info first
        input_info = get_video_info(input_path)
        logger.info(f"Input video: {input_info.get('size_mb', 0):.2f}MB, {input_info.get('duration', 0):.1f}s")
        
        # FFmpeg command with streaming optimization
        cmd = [
            'ffmpeg', '-y',
            '-i', input_path,
            # Video encoding
            '-c:v', 'libx264',
            '-preset', settings['preset'],
            '-crf', str(settings['crf']),
            '-b:v', settings['video_bitrate'],
            '-maxrate', settings['video_bitrate'],
            '-bufsize', f"{int(settings['video_bitrate'].replace('k','')) * 2}k",
            # Scale video with lanczos for better quality
            '-vf', f"scale={settings['resolution']}:flags=lanczos,setdar=16/9",
            # Keyframe interval for smoother seeking (every 2 seconds)
            '-g', '60',
            '-keyint_min', '60',
            # Streaming optimization
            '-movflags', '+faststart+frag_keyframe+empty_moov',
            # Audio encoding
            '-c:a', 'aac',
            '-b:a', settings['audio_bitrate'],
            '-ar', '44100',
            '-ac', '2',  # Stereo for better audio
            # Additional optimizations
            '-pix_fmt', 'yuv420p',
            '-profile:v', 'main',  # Main profile for better compatibility
            '-level', '3.1',
            '-map_metadata', '-1',
            output_path
        ]
        
        logger.info(f"Starting transcode with profile '{profile}'...")
        start_time = datetime.now()
        
        result = subprocess.run(
            cmd, 
            capture_output=True, 
            text=True, 
            timeout=300
        )
        
        elapsed = (datetime.now() - start_time).total_seconds()
        
        if result.returncode != 0:
            logger.error(f"FFmpeg failed: {result.stderr}")
            return False, f"Transcoding failed: {result.stderr[:200]}", {}
        
        # Verify output exists and has reasonable size
        if not Path(output_path).exists() or Path(output_path).stat().st_size == 0:
            return False, "Output file is empty", {}
        
        output_info = get_video_info(output_path)
        
        compression_ratio = 0
        if input_info.get('size_bytes', 0) > 0:
            compression_ratio = (1 - output_info.get('size_bytes', 0) / input_info['size_bytes']) * 100
        
        logger.info(
            f"Transcode complete in {elapsed:.1f}s: "
            f"{input_info.get('size_mb', 0):.2f}MB → {output_info.get('size_mb', 0):.2f}MB "
            f"({compression_ratio:.1f}% reduction)"
        )
        
        return True, "Transcoding successful", {
            'input_size_mb': input_info.get('size_mb', 0),
            'output_size_mb': output_info.get('size_mb', 0),
            'compression_ratio': compression_ratio,
            'duration': output_info.get('duration', 0),
            'elapsed_seconds': elapsed,
            'profile': profile
        }
        
    except subprocess.TimeoutExpired:
        logger.error("Transcoding timeout")
        return False, "Transcoding timed out", {}
    except Exception as e:
        logger.error(f"Transcoding error: {e}")
        return False, str(e), {}


async def transcode_video_async(
    input_path: str,
    output_path: str,
    profile: str = DEFAULT_PROFILE
) -> Tuple[bool, str, dict]:
    """Async wrapper for transcoding - runs in thread pool"""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        _executor,
        transcode_video_sync,
        input_path,
        output_path,
        profile
    )


def should_transcode_sync(input_path: str) -> bool:
    """Determine if video should be transcoded synchronously or queued"""
    info = get_video_info(input_path)
    duration = info.get('duration', 0)
    return duration <= SYNC_TRANSCODE_MAX_DURATION


def select_profile(input_path: str, target_size_mb: float = 7.0) -> str:
    """
    Select transcoding profile.

    For Se-Q emergency reports we always use ultra_compressed regardless of
    duration — these are evidence clips, not cinematic content. Small file
    size and fast upload matter more than quality. The 'standard' and
    'quality' profiles are retained for potential future use.
    """
    return 'ultra_compressed'


class TranscodeQueue:
    """Simple in-memory queue for background transcoding"""
    
    def __init__(self):
        self.queue = asyncio.Queue()
        self.processing = {}
        self.completed = {}
        self._worker_task = None
    
    async def start_worker(self):
        """Start background worker"""
        if self._worker_task is None:
            self._worker_task = asyncio.create_task(self._worker())
            logger.info("Transcode worker started")
    
    async def _worker(self):
        """Background worker that processes queue"""
        while True:
            try:
                job_id, input_path, output_path, profile, callback = await self.queue.get()
                
                self.processing[job_id] = {
                    'status': 'processing',
                    'started_at': datetime.utcnow()
                }
                
                success, message, info = await transcode_video_async(
                    input_path, output_path, profile
                )
                
                self.completed[job_id] = {
                    'status': 'completed' if success else 'failed',
                    'message': message,
                    'info': info,
                    'completed_at': datetime.utcnow()
                }
                
                del self.processing[job_id]
                
                if callback:
                    await callback(job_id, success, message, info)
                
                self.queue.task_done()
                
            except Exception as e:
                logger.error(f"Worker error: {e}")
    
    async def enqueue(
        self,
        input_path: str,
        output_path: str,
        profile: str = DEFAULT_PROFILE,
        callback=None
    ) -> str:
        """Add job to queue, returns job_id"""
        job_id = str(uuid.uuid4())
        await self.queue.put((job_id, input_path, output_path, profile, callback))
        return job_id
    
    def get_status(self, job_id: str) -> dict:
        """Get job status"""
        if job_id in self.processing:
            return self.processing[job_id]
        if job_id in self.completed:
            return self.completed[job_id]
        return {'status': 'queued'}


# Global queue instance
transcode_queue = TranscodeQueue()
