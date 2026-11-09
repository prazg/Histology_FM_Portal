FROM pytorch/pytorch:2.4.1-cuda12.1-cudnn9-runtime

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PORTAL_WORK_DIR=/data/work

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    build-essential \
    libopenslide0 \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY docs/ /app/docs/
COPY backend/ /app/backend/

WORKDIR /app/backend

RUN pip install --no-cache-dir \
    "fastapi>=0.110" \
    "uvicorn[standard]" \
    python-multipart \
    numpy \
    pillow \
    pyyaml \
    h5py \
    huggingface_hub \
    transformers \
    open_clip_torch \
    timm \
    openslide-python

# Install TRIDENT for patch/slide encoders and WSI segmentation
RUN git clone --depth 1 https://github.com/mahmoodlab/TRIDENT.git external/TRIDENT && \
    pip install --no-cache-dir -e "external/TRIDENT[patch-encoders,slide-encoders]" || true

EXPOSE 8000

CMD ["python", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
