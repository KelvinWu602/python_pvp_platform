# Documentation

This directory holds centralized reference documentation for the project.

| Document | Contents |
|---|---|
| `architecture.md` | Full system architecture, component roles, battle flow, data model |
| `security.md` | Secrets management, credential handling, IAM policies, network security |

## Component-specific documentation

| Document | Location | Contents |
|---|---|---|
| Simulator deployment | `../simulator/deployment.md` | SQS, IAM, ECR image, Lambda creation, event source mapping |
| Simulator testing | `../simulator/test-guide.md` | End-to-end local test (RIE) and deployed Lambda test |
| Simulator design | `../simulator/design.md` | Lambda file structure, execution flow, client interface |
| Database setup | `../database/readme.md` | Local tunnel, migration order, DB port notes |
| AWS resources | `../AWS resource.md` | Full AWS resource inventory (RDS, Lambda, S3, SQS, IAM) |
| API server deploy | `../deploy/` | IAM policy, systemd unit, SSM bootstrap script for EC2 |

## Quick links

- [Architecture](architecture.md)
- [Security](security.md)
- [Simulator deployment](../simulator/deployment.md)
- [API server deployment](../deploy/)
- [AWS resources](../AWS%20resource.md)