variable "NAME" {
  default = "ghost-s3"
}

variable "IMAGE" {
  default = "ghcr.io/coto-studio/${NAME}"
}

variable "REPO" {
  default = "https://github.com/Coto-Studio/${NAME}"
}

target "default" {
  context = "."
  dockerfile = "Dockerfile"
  tags = ["${IMAGE}:latest"]
  label = {
    "org.opencontainers.image.source" = "${REPO}"
  }
  cache-from = [
    {
      type = "registry"
      ref = "${IMAGE}:buildcache"
    }
  ]
  cache-to = [
    {
      type = "registry"
      ref = "${IMAGE}:buildcache"
      mode = "max"
    }
  ]
  platforms = ["linux/amd64", "linux/arm64"]
}