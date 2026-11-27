# AEC — AWS Emulator Console

A lightweight, zero-dependency local web console for [AWS Emulator](https://github.com/aws/aws-emulator).

## Features

- **Overview:** Live emulator health (`/__admin/health`), active caller identity (`sts:GetCallerIdentity`), and resource summary.
- **S3 Console:** Create/delete buckets, upload files (drag-and-drop or text), preview/download objects, toggle Block Public Access, edit bucket policies (with one-click public-read preset), and test **unsigned anonymous `GET`** requests directly.
- **IAM Console:** Create/delete users, mint access keys (stored only in local server memory — never exposed to the browser), attach/edit/delete inline policies, and switch the console's **Active Caller** to any IAM user to verify real least-privilege enforcement across S3, DynamoDB, EC2, and the API Playground.
- **DynamoDB Console:** Create/delete tables, scan items, put/delete JSON items.
- **EC2 Console:** Launch, start, stop, and terminate emulated instances.
- **API Playground & Live API Call Inspector:** Send custom signed or unsigned AWS requests (REST, Query, or JSON Target) and inspect every request/response made to the emulator.

## Quick Start

### 1. Start AWS Emulator with Docker

This repo includes a multi-arch Dockerfile ([docker/aws-emulator.Dockerfile](docker/aws-emulator.Dockerfile)) that automatically downloads the official prebuilt `aarch64` (Apple Silicon / ARM) or `x86_64` (Intel/AMD) RPM from AWS with telemetry disabled (`EMULATOR_TELEMETRY=off`).

Build the image:

```bash
docker build -t aws-emulator -f docker/aws-emulator.Dockerfile docker
```

Run the emulator (macOS / Linux):

```bash
mkdir -p ~/.aws/emulator

docker run -d --rm --name aws-emulator --memory=2g --memory-swap=2g \
  -p 127.0.0.1:9297:9297 \
  -e HOME="$HOME" \
  -v "$HOME/.aws/emulator:$HOME/.aws/emulator" \
  aws-emulator
```

> **Tip (RDS / ElastiCache / Aurora DSQL TCP endpoints):** To also connect directly to emulated TCP database/cache ports from your host, expose a listener port range when starting the container:
> ```bash
> -e EMULATOR_LISTENER_PORT_RANGE=15432-15440 \
> -p 127.0.0.1:15432-15440:15432-15440
> ```
>
> **Building from source instead (Linux only):** See the official [aws/aws-emulator](https://github.com/aws/aws-emulator) repository and [AWS Emulator User Guide](https://docs.aws.amazon.com/emulator/latest/userguide/what-is-service.html).

### 2. Start AEC

Requires Python 3.10+ (standard library only — no `pip install` needed):

```bash
python3 server.py
```

Open **http://127.0.0.1:9298** in your browser.

### 3. Point AWS CLI / SDKs at the Emulator (optional)

```bash
export AWS_ENDPOINT_URL=https://127.0.0.1:9297
export AWS_SHARED_CREDENTIALS_FILE=~/.aws/emulator/9297/emulator_credentials
export AWS_CONFIG_FILE=~/.aws/emulator/9297/config
export AWS_CA_BUNDLE=~/.aws/emulator/9297/ca.pem
export AWS_EC2_METADATA_DISABLED=true
export AWS_DISABLE_HOST_PREFIX_INJECTION=true
export AWS_REGION=us-east-1
export AWS_DEFAULT_REGION=us-east-1
```

### Stopping the Emulator

```bash
docker stop aws-emulator
```

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `AEC_HOST` | `127.0.0.1` | Bind address for the web console |
| `AEC_PORT` | `9298` | Port for the web console |
| `EMULATOR_HOST` | `127.0.0.1` | AWS Emulator host |
| `EMULATOR_PORT` | `9297` | AWS Emulator port (reads `~/.aws/emulator/<port>/`) |
| `AWS_REGION` | `us-east-1` | Default AWS region |
