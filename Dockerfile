# fslab in the browser: real Debian binaries, one fslab shell per student.
#   docker build -t fslab .
#   docker run -p 8080:8080 -e FSLAB_TEACHER_KEY=secret -v fslab-labs:/labs fslab
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends tree coreutils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY web/requirements.txt web/requirements.txt
RUN pip install --no-cache-dir -r web/requirements.txt
COPY fslab.py .
COPY web web
RUN useradd -m student && mkdir -p /labs && chown student /labs
USER student
ENV FSLAB_LABS=/labs FSLAB_PORT=8080 LANG=C.UTF-8
EXPOSE 8080
CMD ["python3", "web/server.py"]
