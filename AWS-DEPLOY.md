# Deploy Quantum-Assisted Unit Commitment on AWS

This guide uses one Amazon EC2 GPU instance. The React frontend and the
FastAPI/CUDA-Q backend run in one Docker container and are available through
one public address.

## 1. Before launching the instance

### Request the GPU quota

Open:

```text
AWS Console → Service Quotas → AWS services → Amazon Elastic Compute Cloud
```

Find:

```text
Running On-Demand G and VT instances
```

Request at least **4 vCPUs**, which is enough for one `g4dn.xlarge`. New AWS
accounts can have this quota set to zero.

### Choose a Region

For users in Vietnam, Singapore (`ap-southeast-1`) is a practical first choice
when `g4dn.xlarge` capacity is available. The GPU quota is separate for every
Region, so request it in the same Region where the instance will run.

## 2. Launch the EC2 instance

Open:

```text
EC2 → Instances → Launch instances
```

Use these settings:

| Setting | Recommended value |
|---|---|
| Name | `quantum-assisted-unit-commitment` |
| AMI | Latest **AWS Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 22.04)**, x86_64 |
| Instance type | `g4dn.xlarge` |
| Key pair | Create/download a `.pem` key |
| Public IP | Enabled |
| Storage | 80 GiB gp3 |

The `g4dn.xlarge` supplies one NVIDIA T4 GPU. The CUDA-Q image is several GB,
so 80 GiB avoids running out of space during Docker builds.

### Security group inbound rules

| Type | Port | Source |
|---|---:|---|
| SSH | 22 | **My IP** only |
| HTTP | 80 | `0.0.0.0/0` |
| HTTPS | 443 | `0.0.0.0/0` only if HTTPS is added later |

Do not expose port 8000. Docker maps public port 80 to the internal application
port.

## 3. Connect through SSH

On your own computer:

```bash
chmod 400 your-key.pem
ssh -i your-key.pem ubuntu@YOUR_EC2_PUBLIC_IP
```

Verify that the AMI can see the GPU:

```bash
nvidia-smi
```

Do not continue until this command shows an NVIDIA GPU.

## 4. Put the source code on EC2

### Option A — clone the public GitHub repository

```bash
git clone https://github.com/YOUR_USERNAME/YOUR_REPOSITORY.git
cd YOUR_REPOSITORY
```

### Option B — upload the ZIP from your computer

Run locally:

```bash
scp -i your-key.pem Quantum-Assisted-Unit-Commitment-AWS.zip \
  ubuntu@YOUR_EC2_PUBLIC_IP:/home/ubuntu/
```

Then on EC2:

```bash
sudo apt-get update
sudo apt-get install -y unzip
unzip Quantum-Assisted-Unit-Commitment-AWS.zip
cd Quantum-Assisted-Unit-Commitment
```

## 5. Install Docker and NVIDIA container support

From the repository root:

```bash
sudo bash deploy/aws-ec2/scripts/install-host.sh
```

The script:

1. refuses to continue if `nvidia-smi` is missing;
2. installs Docker Engine and Docker Compose;
3. installs NVIDIA Container Toolkit;
4. configures Docker's NVIDIA runtime;
5. runs a GPU test container.

## 6. Build and start the application

```bash
bash deploy/aws-ec2/scripts/deploy.sh
```

The first build can take a long time because the official CUDA-Q container is
large and the quantum Python dependencies must be installed.

Open in a browser:

```text
http://YOUR_EC2_PUBLIC_IP
```

API checks:

```text
http://YOUR_EC2_PUBLIC_IP/api/health
http://YOUR_EC2_PUBLIC_IP/api/docs
http://YOUR_EC2_PUBLIC_IP/api/deployment
```

A correct health response must contain:

```json
{
  "cudaq": {
    "available": true,
    "target": "nvidia",
    "execution_device": "gpu"
  }
}
```

## 7. Useful commands

Follow logs:

```bash
bash deploy/aws-ec2/scripts/logs.sh
```

Verify locally or by public IP:

```bash
bash deploy/aws-ec2/scripts/verify.sh
bash deploy/aws-ec2/scripts/verify.sh YOUR_EC2_PUBLIC_IP
```

Deploy a new Git commit:

```bash
bash deploy/aws-ec2/scripts/update.sh
```

Restart the app:

```bash
sudo docker compose --env-file deploy/aws-ec2/.env \
  -f deploy/aws-ec2/compose.yaml restart app
```

Remove only the application container:

```bash
bash deploy/aws-ec2/scripts/remove-app.sh
```

## 8. Control AWS costs

A GPU EC2 instance is not covered by the ordinary free tier. Use On-Demand for
the first deployment and stop the instance when nobody needs the demo:

```text
EC2 → Instances → select the instance → Instance state → Stop instance
```

Stopping releases the billed compute capacity, but EBS storage and public IPv4
charges can continue. A normal automatically assigned public IPv4 address can
also change after a stop/start cycle.

For a student portfolio, the least expensive workflow is:

1. start the instance before a demo;
2. wait for Docker to restart the application automatically;
3. share the current public IP;
4. stop the instance after the session.

Do not terminate the instance unless you want to delete it permanently.

## 9. Public-demo safeguards

The AWS entry point includes:

- one Uvicorn worker;
- one GPU run at a time;
- HTTP 429 while the GPU is busy;
- a per-client cooldown, default 15 seconds;
- no CPU fallback when CUDA-Q is unavailable.

Change the cooldown in:

```text
deploy/aws-ec2/.env
```

then redeploy.

## 10. HTTPS and a stable domain

The supplied deployment intentionally starts with plain HTTP and a public IP to
keep the first deployment simple. Add a domain and HTTPS only after the GPU
application works correctly.

A stable Elastic IP is optional. Remember that AWS charges for public IPv4
addresses, including Elastic IP addresses. Without an Elastic IP, the public IP
can change after the instance is stopped and started.

## Troubleshooting

### `InsufficientInstanceCapacity`

Try another Availability Zone or Region, or use `g5.xlarge` if your quota and
budget permit it.

### Quota error when launching

Increase `Running On-Demand G and VT instances` to at least four vCPUs in the
same Region.

### `could not select device driver "nvidia"`

Run the host installation script again and confirm:

```bash
nvidia-smi
sudo docker run --rm --gpus all \
  nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi
```

### Health endpoint reports CPU or unavailable

Inspect logs:

```bash
bash deploy/aws-ec2/scripts/logs.sh
```

The deployment intentionally sets `REQUIRE_CUDAQ=1`, so a CUDA-Q failure must
be fixed rather than silently replaced by the NumPy fallback.

### Browser cannot connect

Check that:

- the EC2 instance is running;
- security-group port 80 is open;
- the container is healthy;
- you used `http://`, not `https://`, for the initial deployment.
