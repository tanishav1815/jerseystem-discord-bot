FROM python:3.11-slim

# Prevent Python from writing .pyc files to disk
ENV PYTHONDONTWRITEBYTECODE 1
# Prevent Python from buffering stdout/stderr
ENV PYTHONUNBUFFERED 1

WORKDIR /app

# Copy requirements list
COPY requirements.txt .

# Install dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy source code and scripts
COPY src/ src/
COPY scripts/ scripts/

CMD ["python", "-m", "src.main"]
