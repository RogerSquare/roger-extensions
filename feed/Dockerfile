FROM python:3.12-slim
RUN pip install --no-cache-dir pillow==11.0.0
WORKDIR /app
COPY feed.py .
USER 1000:1000
EXPOSE 4580
CMD ["python", "-u", "feed.py"]
