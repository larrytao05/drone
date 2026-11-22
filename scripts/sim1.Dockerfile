FROM python:3.12-slim
COPY requirements-sim.txt /tmp/requirements-sim.txt
RUN pip install --no-cache-dir -r /tmp/requirements-sim.txt
