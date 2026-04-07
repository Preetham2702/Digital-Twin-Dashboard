FROM python:3.10

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["gunicorn", "-k", "uvicorn.workers.UvicornWorker", "main:app", "-w", "2", "-b", "0.0.0.0:8000"]

