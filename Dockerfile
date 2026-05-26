FROM python:3.11-slim

WORKDIR /app

COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/server.py ./server.py
COPY backend/services.py ./services.py
COPY backend/video_transcoder.py ./video_transcoder.py

RUN mkdir -p uploads/photos uploads/videos

EXPOSE 8000

CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port ${PORT:-8000} --timeout-keep-alive 300"]
