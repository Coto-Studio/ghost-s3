variable "BASE_IMAGE" {
  default = "ghost"
}

variable "NAME" {
  default = "ghost-s3"
}

variable "GHCR_IMAGE" {
  default = "ghcr.io/coto-studio/${NAME}"
}

variable "REPO" {
  default = "https://github.com/Coto-Studio/${NAME}"
}

variable "BASE_TAG" {
  default = "6-alpine"
}

variable "LEGACY_TAG" {
  default = "5-alpine"
}


group "default" {
  targets = ["latest"]
}

target "default" {
  context = "."
  contexts = {
    ghost = "docker-image://${BASE_IMAGE}:${BASE_TAG}"
  }
  dockerfile = "Dockerfile"
  tags = ["${GHCR_IMAGE}:latest","${GHCR_IMAGE}:${BASE_TAG}","${GHCR_IMAGE}:6"]
  label = {
    "org.opencontainers.image.source" = "${REPO}"
  }
  cache-from = [
    {
      type = "registry"
      ref = "${GHCR_IMAGE}:buildcache"
    }
  ]
  cache-to = [
    {
      type = "registry"
      ref = "${GHCR_IMAGE}:buildcache"
      mode = "max"
    }
  ]
  platforms = ["linux/amd64", "linux/arm64"]
  output = [
    { 
      type = "registry" 
    }
  ] 
}

target "latest" {
   inherits = ["default"]
   contexts = {
     ghost = "docker-image://${BASE_IMAGE}:${BASE_TAG}"
   }
}

target "legacy" {
   inherits = ["default"]
   contexts = {
     ghost = "docker-image://${BASE_IMAGE}:${LEGACY_TAG}"
   }
   tags = ["${GHCR_IMAGE}:legacy","${GHCR_IMAGE}:${LEGACY_TAG}"]
}

