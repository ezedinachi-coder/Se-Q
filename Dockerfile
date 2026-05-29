FROM python:3.11-slim

WORKDIR /app

# Copy requirements first for better caching
COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copy the entire backend folder
COPY backend/ ./backend/

# Create upload directories
RUN mkdir -p uploads/photos uploads/videos

EXPOSE 8000

# Fix: Point to the correct main.py file
CMD ["sh", "-c", "uvicorn backend.app.main:app --host 0.0.0.0 --port ${PORT:-8000} --timeout-keep-alive 300"]
