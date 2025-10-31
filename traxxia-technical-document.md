# Traxxia Application - Technical Architecture & DevOps Design Document

**Version:** 1.0  
**Date:** October 2025  
**Prepared By:** Piquota DevOps Team  
**Document Classification:** Client Technical Documentation

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Architecture Overview](#architecture-overview)
3. [ARM Templates Structure](#arm-templates-structure)
4. [Azure Services & Configuration](#azure-services--configuration)
5. [Network Architecture](#network-architecture)
6. [Security & Identity Management](#security--identity-management)
7. [Azure DevOps Branching Strategy](#azure-devops-branching-strategy)
8. [CI/CD Pipeline Architecture](#cicd-pipeline-architecture)
9. [Deployment Strategies](#deployment-strategies)
10. [Monitoring & Alerting](#monitoring--alerting)
11. [Future Enhancements](#future-enhancements)
12. [Appendix](#appendix)

---

## Executive Summary

This document provides a comprehensive technical overview of the Traxxia application infrastructure deployed on Microsoft Azure. The architecture leverages Azure Kubernetes Service (AKS) as the primary container orchestration platform, supported by Azure Container Registry (ACR), Azure Key Vault, and Azure Storage services.

The application consists of three core components:
- **Frontend**: User interface application
- **Backend**: Business logic and API services
- **ML Backend**: Machine learning model serving and inference

All components are containerized and deployed on a highly available, auto-scaling AKS cluster with integrated CI/CD pipelines for automated build, test, and deployment processes.

**Key Highlights:**
- Production-ready container orchestration with AKS
- Automated CI/CD pipelines with Azure DevOps
- Secure secrets management with Azure Key Vault
- High availability with multi-zone deployment
- Automated monitoring and alerting
- Infrastructure as Code (IaC) with ARM templates

---

## Architecture Overview

### High-Level Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Azure DevOps Organization                         │
│                    https://dev.azure.com/mypiquota/Traxxia               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                   │
│  │  Frontend    │  │   Backend    │  │  ML Backend  │                   │
│  │  Repository  │  │  Repository  │  │  Repository  │                   │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘                   │
│         │                  │                  │                           │
│         └──────────────────┼──────────────────┘                           │
│                            │                                             │
│              ┌─────────────▼──────────────┐                               │
│              │    CI Pipelines            │                               │
│              │  (Auto-triggered on PR)    │                               │
│              └─────────────┬──────────────┘                               │
│                            │                                             │
│              ┌─────────────▼──────────────┐                               │
│              │    Azure Container          │                               │
│              │    Registry (ACR)           │                               │
│              │    traxdevacr.azurecr.io   │                               │
│              └─────────────┬──────────────┘                               │
│                            │                                             │
└────────────────────────────┼─────────────────────────────────────────────┘
                             │
                             │ CD Pipeline
                             │ (Manual trigger from master)
                             ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Azure Subscription                                    │
│                    Region: Central US                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │              Resource Group: trax-dev-core-rg                    │   │
│  ├─────────────────────────────────────────────────────────────────┤   │
│  │                                                                   │   │
│  │  ┌───────────────────────────────────────────────────────────┐  │   │
│  │  │        Virtual Network: trax-dev-core-vnet               │  │   │
│  │  │        Address Space: 172.16.0.0/23                      │  │   │
│  │  │        ┌──────────────────────────────────────────┐      │  │   │
│  │  │        │ AKS Subnet: trax-dev-core-aks-subnet      │      │  │   │
│  │  │        │ 172.16.0.0/24                            │      │  │   │
│  │  │        └──────────────────────────────────────────┘      │  │   │
│  │  └───────────────────────────────────────────────────────────┘  │   │
│  │                                                                   │   │
│  │  ┌───────────────────────────────────────────────────────────┐  │   │
│  │  │  Azure Kubernetes Service: trax-dev-aks                  │  │   │
│  │  │  Kubernetes Version: 1.32.7                              │  │   │
│  │  │  ┌──────────────────┐  ┌──────────────────┐              │  │   │
│  │  │  │ System Pool      │  │ User Pool        │              │  │   │
│  │  │  │ (agentpool)      │  │ (userpool)       │              │  │   │
│  │  │  │ Min: 1, Max: 2   │  │ Min: 1, Max: 2   │              │  │   │
│  │  │  │ VM Size: D2ds_v5  │  │ VM Size: D2ds_v5 │              │  │   │
│  │  │  │ Zones: 1,2,3      │  │ Zones: 1,2,3     │              │  │   │
│  │  │  └──────────────────┘  └──────────────────┘              │  │   │
│  │  │                                                        │  │   │
│  │  │  ┌────────────┐  ┌────────────┐  ┌────────────┐      │  │   │
│  │  │  │ Frontend   │  │  Backend   │  │ ML Backend │      │  │   │
│  │  │  │  Pods      │  │   Pods     │  │   Pods     │      │  │   │
│  │  │  └────────────┘  └────────────┘  └────────────┘      │  │   │
│  │  └───────────────────────────────────────────────────────────┘  │   │
│  │                                                                   │   │
│  │  ┌───────────────────────────────────────────────────────────┐  │   │
│  │  │  Azure Container Registry: traxdevacr                     │  │   │
│  │  │  SKU: Premium | Zone Redundant: Enabled                   │  │   │
│  │  └───────────────────────────────────────────────────────────┘  │   │
│  │                                                                   │   │
│  │  ┌───────────────────────────────────────────────────────────┐  │   │
│  │  │  Azure Key Vault: trax-dev-akv                           │  │   │
│  │  │  Secrets: API Keys, Connection Strings, Encryption Keys │  │   │
│  │  └───────────────────────────────────────────────────────────┘  │   │
│  │                                                                   │   │
│  │  ┌───────────────────────────────────────────────────────────┐  │   │
│  │  │  Azure Storage Account: traxdevasa                        │  │   │
│  │  │  SKU: Standard_RAGRS | Location: East US                 │  │   │
│  │  │  Container: traxxiacontainer                             │  │   │
│  │  └───────────────────────────────────────────────────────────┘  │   │
│  │                                                                   │   │
│  │  ┌───────────────────────────────────────────────────────────┐  │   │
│  │  │  Azure Monitor & Alerting                                 │  │   │
│  │  │  - CPU Usage Alerts (>95%)                               │  │   │
│  │  │  - Memory Usage Alerts (>100%)                           │  │   │
│  │  └───────────────────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │      Managed Resource Group (Auto-created by AKS)               │   │
│  │      MC_trax-dev-core-rg_trax-dev-aks_centralus                 │   │
│  │      - Load Balancers                                            │   │
│  │      - Virtual Machine Scale Sets                                │   │
│  │      - Network Security Groups                                   │   │
│  │      - Public IP Addresses                                       │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## ARM Templates Structure

The infrastructure is defined using Azure Resource Manager (ARM) templates, following Infrastructure as Code (IaC) best practices. The templates are organized into two main categories:

### 1. Core Infrastructure Template (`trax-dev-core-rg/template.json`)

This template deploys the primary application infrastructure resources:

**Resources Deployed:**
- Azure Kubernetes Service (AKS) Cluster
- Azure Container Registry (ACR)
- Azure Key Vault
- Azure Storage Account
- Virtual Network and Subnets
- Action Groups for Monitoring
- Metric Alerts
- Key Vault Secrets (placeholders)

**Location:** `trax-dev-core-rg/template.json`  
**Parameters:** `trax-dev-core-rg/parameters.json`

### 2. Managed Resource Group Template (`MC_trax-dev-core-rg_trax-dev-aks_centralus/template.json`)

This template manages resources that are automatically created by AKS in the managed resource group:

**Resources Managed:**
- User Assigned Identities for AKS components
- Network Security Groups (NSG) for agent pools
- Load Balancers (Standard SKU)
- Public IP Addresses for ingress and outbound connectivity
- Virtual Machine Scale Sets for node pools
- AKS-related extensions and configurations

**Location:** `MC_trax-dev-core-rg_trax-dev-aks_centralus/template.json`  
**Parameters:** `MC_trax-dev-core-rg_trax-dev-aks_centralus/parameters.json`

### Deployment Flow

```
┌─────────────────┐
│ ARM Template    │
│ (trax-dev-core-rg)   │
└────────┬────────┘
         │
         ├──► Azure Kubernetes Service
         │         │
         │         └──► Auto-creates Managed RG
         │                   │
         │                   └──► Resources managed by
         │                         MC_trax-dev-core-rg_trax-dev-aks_centralus template
         │
         ├──► Azure Container Registry
         ├──► Azure Key Vault
         ├──► Azure Storage Account
         └──► Virtual Network
```

---

## Azure Services & Configuration

### 1. Azure Kubernetes Service (AKS)

**Service Name:** `trax-dev-aks`  
**Purpose:** Primary container orchestration platform hosting all application workloads (Frontend, Backend, ML Backend)

**Configuration Details:**

| Parameter | Value | Purpose |
|-----------|-------|---------|
| **Kubernetes Version** | 1.32.7 | Latest stable Kubernetes version with security patches |
| **Location** | Central US | Primary deployment region |
| **SKU Tier** | Free | No SLA guarantee (can be upgraded to Standard for SLA) |
| **Identity Type** | SystemAssigned | Managed identity for Azure resource access |
| **RBAC** | Enabled | Role-based access control for cluster security |
| **Network Plugin** | Azure CNI | Native Azure networking integration |
| **Network Policy** | Calico | Pod-level network isolation and security |
| **Load Balancer SKU** | Standard | Production-grade load balancing |
| **Service CIDR** | 10.0.0.0/16 | Internal service network range |
| **DNS Service IP** | 10.0.0.10 | Internal DNS resolution |

**Node Pools Configuration:**

#### System Node Pool (`agentpool`)
- **Purpose:** Hosts critical system pods (kube-system, ingress controllers, etc.)
- **VM Size:** Standard_D2ds_v5 (2 vCPUs, 8 GB RAM)
- **Min Nodes:** 1
- **Max Nodes:** 2
- **Initial Count:** 1
- **Auto-scaling:** Enabled
- **Availability Zones:** 1, 2, 3 (zone-redundant)
- **Node Taints:** `CriticalAddonsOnly=true:NoSchedule`
- **Mode:** System
- **OS Disk:** 128 GB Managed
- **Upgrade Settings:**
  - Max Surge: 10%
  - Max Unavailable: 0 (zero-downtime upgrades)

#### User Node Pool (`userpool`)
- **Purpose:** Hosts application workloads (Frontend, Backend, ML Backend)
- **VM Size:** Standard_D2ds_v5 (2 vCPUs, 8 GB RAM)
- **Min Nodes:** 1
- **Max Nodes:** 2
- **Initial Count:** 1
- **Auto-scaling:** Enabled
- **Availability Zones:** 1, 2, 3 (zone-redundant)
- **Mode:** User
- **OS Disk:** 128 GB Managed
- **Upgrade Settings:**
  - Max Surge: 10%
  - Max Unavailable: 0

**Key Features Enabled:**
- **Workload Identity:** Enabled for secure pod-to-Azure authentication
- **Azure Key Vault Secrets Provider:** Enabled for automatic secret injection
- **Azure Policy:** Enabled for governance and compliance
- **Image Cleaner:** Enabled (weekly cleanup of unused images)
- **Auto-Upgrade:** Patch channel (automatic patch updates)
- **Node OS Upgrade:** NodeImage channel

**Auto-scaler Profile:**
- Scale-down delay: 10 minutes after node addition
- Scale-down utilization threshold: 50%
- Scan interval: 10 seconds
- Max node provision time: 15 minutes

### 2. Azure Container Registry (ACR)

**Service Name:** `traxdevacr`  
**Purpose:** Private Docker container registry for storing and managing application container images

**Configuration Details:**

| Parameter | Value | Purpose |
|-----------|-------|---------|
| **SKU** | Premium | Required for geo-replication and zone redundancy |
| **Location** | Central US | Primary region |
| **Zone Redundancy** | Enabled | High availability across availability zones |
| **Admin User** | Enabled | Provides basic authentication (consider disabling for production) |
| **Public Network Access** | Enabled | Allows pull/push from internet |
| **Network Rule Bypass** | AzureServices | Azure services can bypass network rules |
| **Retention Policy** | 7 days | Automatic cleanup of old images (currently disabled) |
| **Soft Delete** | Disabled | Permanently delete images immediately |

**IP Rules (Allowed IPs):**
- `135.119.64.219` - Allowed for push/pull operations
- `223.181.105.224` - Allowed for push/pull operations

**Scope Maps Created:**
- `_repositories_admin`: Full read/write/delete access
- `_repositories_pull`: Read-only access for pulling images
- `_repositories_push`: Write access for pushing images

**Replication:**
- Central US region replication enabled with zone redundancy

### 3. Azure Key Vault

**Service Name:** `trax-dev-akv`  
**Purpose:** Centralized secrets management for application credentials, API keys, and sensitive configuration

**Configuration Details:**

| Parameter | Value | Purpose |
|-----------|-------|---------|
| **SKU** | Standard | Standard tier with soft delete enabled |
| **Location** | Central US | Primary region |
| **Soft Delete** | Enabled | Protection against accidental deletion |
| **Retention Days** | 90 | How long deleted secrets are retained |
| **Public Network Access** | Enabled | Accessible from internet (can be restricted) |
| **RBAC Authorization** | Disabled | Using access policies (consider migrating to RBAC) |

**Secrets Configured:**
- `ALPHA-VANT-API-KEY` - Alpha Vantage API credentials
- `AZURE-STORAGE-KEY` - Azure Storage access key
- `ENCRYPTION-KEY` - Application encryption key
- `GROQ-API-KEY` - Groq API credentials
- `MONGO-URI` - MongoDB connection string
- `NEWSAPI-API-KEY` - News API credentials
- `OPENAI-API-KEY` - OpenAI API credentials
- `PERPLEXITY-API-KEY` - Perplexity AI API credentials
- `SECRET-KEY` - Application secret key

**Access Policies:**
- Multiple service principals with appropriate permissions (get, list, set for secrets)
- Different permission levels based on operational requirements

**Integration:**
- Integrated with AKS via Azure Key Vault Secrets Provider addon
- Secrets automatically synced to Kubernetes secrets for pod consumption

### 4. Azure Storage Account

**Service Name:** `traxdevasa`  
**Purpose:** Object storage for application data, files, and static assets

**Configuration Details:**

| Parameter | Value | Purpose |
|-----------|-------|---------|
| **SKU** | Standard_RAGRS | Read-access geo-redundant storage |
| **Location** | East US | Primary region (different from AKS for geo-distribution) |
| **Kind** | StorageV2 | Latest generation storage account |
| **TLS Version** | TLS 1.2 | Minimum TLS version for secure connections |
| **Blob Public Access** | Disabled | Prevents public blob access |
| **Large File Shares** | Enabled | Support for large file shares |
| **Access Tier** | Hot | Frequently accessed data |

**Storage Services:**
- **Blob Storage:** Container `traxxiacontainer` for application data
  - Delete retention: 7 days
- **File Storage:** For shared file access
  - Share delete retention: 7 days
- **Queue Storage:** For asynchronous message processing
- **Table Storage:** For structured NoSQL data

**Data Protection:**
- Geo-redundant replication for disaster recovery
- Soft delete enabled for blobs and file shares (7 days retention)

### 5. Virtual Network

**Service Name:** `trax-dev-core-vnet`  
**Purpose:** Isolated network environment for AKS cluster and associated resources

**Configuration Details:**

| Parameter | Value | Purpose |
|-----------|-------|---------|
| **Address Space** | 172.16.0.0/23 | Network address range (512 IPs) |
| **Location** | Central US | Same region as AKS cluster |
| **DDoS Protection** | Disabled | Can be enabled for production |

**Subnets:**

**AKS Subnet (`trax-dev-core-aks-subnet`):**
- Address Prefix: `172.16.0.0/24` (256 IPs)
- Delegated to: Microsoft.ContainerService/managedClusters
- Purpose: Hosts all AKS node pools and pod IPs

**Network Policies:**
- Private Endpoint Policies: Disabled
- Private Link Service Policies: Enabled

### 6. Azure Monitor & Alerting

**Action Group:** `RecommendedAlertRules-AG-1`
- **Email Recipients:** muthukumar@piquota.com
- **Purpose:** Notification channel for metric alerts

**Metric Alerts Configured:**

1. **CPU Usage Alert:**
   - Name: `CPU Usage Percentage - trax-dev-aks`
   - Threshold: > 95%
   - Evaluation Frequency: 5 minutes
   - Window Size: 5 minutes
   - Severity: 3 (Informational)

2. **Memory Usage Alert:**
   - Name: `Memory Working Set Percentage - trax-dev-aks`
   - Threshold: > 100%
   - Evaluation Frequency: 5 minutes
   - Window Size: 5 minutes
   - Severity: 3 (Informational)

---

## Network Architecture

### Network Flow Diagram

```
Internet
   │
   │ HTTPS (443) / HTTP (80)
   ▼
┌─────────────────────────────────────┐
│   Azure Load Balancer (Standard)    │
│   Public IP: 128.203.160.254        │
└──────────────┬──────────────────────┘
               │
               │ Internal Routing
               ▼
┌─────────────────────────────────────┐
│   Virtual Network: trax-dev-core-vnet│
│   172.16.0.0/23                      │
│   ┌──────────────────────────────┐   │
│   │ AKS Subnet: 172.16.0.0/24    │   │
│   │ ┌────────────────────────┐  │   │
│   │ │ Ingress Controller     │  │   │
│   │ │ (nginx-ingress)        │  │   │
│   │ └─────────┬──────────────┘  │   │
│   │           │                  │   │
│   │   ┌───────┼───────┐          │   │
│   │   │       │       │          │   │
│   │   ▼       ▼       ▼          │   │
│   │ ┌────┐ ┌────┐ ┌────┐        │   │
│   │ │FE  │ │BE  │ │ML  │        │   │
│   │ │Pod │ │Pod │ │Pod │        │   │
│   │ └────┘ └────┘ └────┘        │   │
│   └──────────────────────────────┘   │
└─────────────────────────────────────┘
```

### Security Groups (NSG) Rules

**Network Security Group:** `aks-agentpool-83520044-nsg`

**Inbound Rules:**
- **Port 80:** Allow from Internet to Load Balancer IP (132.196.123.254)
- **Port 443:** Allow from Internet to Load Balancer IP (128.203.160.254)
- **Port 5000:** Allow from Internet to Load Balancer IPs (specific service)

**Purpose:** Controls traffic flow to AKS node pools, ensuring only authorized access.

---

## Security & Identity Management

### Identity Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Identity Model                        │
├─────────────────────────────────────────────────────────┤
│                                                           │
│  ┌──────────────────────────────────────────────────┐   │
│  │  System-Assigned Managed Identity                 │   │
│  │  (AKS Cluster Identity)                          │   │
│  │  - Cluster operations                            │   │
│  │  - Resource creation in managed RG              │   │
│  └──────────────────────────────────────────────────┘   │
│                                                           │
│  ┌──────────────────────────────────────────────────┐   │
│  │  User-Assigned Managed Identities                │   │
│  │  ┌──────────────────────────────────────────┐    │   │
│  │  │ trax-dev-aks-agentpool                   │    │   │
│  │  │ - Kubelet operations                     │    │   │
│  │  │ - ACR pull permissions                   │    │   │
│  │  └──────────────────────────────────────────┘    │   │
│  │  ┌──────────────────────────────────────────┐    │   │
│  │  │ azurekeyvaultsecretsprovider-trax-dev-aks│    │   │
│  │  │ - Key Vault secret access                 │    │   │
│  │  └──────────────────────────────────────────┘    │   │
│  │  ┌──────────────────────────────────────────┐    │   │
│  │  │ azurepolicy-trax-dev-aks                 │    │   │
│  │  │ - Azure Policy enforcement                │    │   │
│  │  └──────────────────────────────────────────┘    │   │
│  └──────────────────────────────────────────────────┘   │
│                                                           │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Workload Identity                                │   │
│  │  - Pod-to-Azure authentication                    │   │
│  │  - OIDC issuer enabled                            │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### Security Features

1. **RBAC (Role-Based Access Control)**
   - Enabled on AKS cluster
   - Kubernetes RBAC for cluster access
   - Azure RBAC for Azure resource access

2. **Network Policies**
   - Calico network policy engine
   - Pod-level network isolation
   - Egress/ingress traffic control

3. **Secret Management**
   - Azure Key Vault for centralized secrets
   - Automatic secret rotation support
   - Secrets Provider addon for Kubernetes integration

4. **Image Security**
   - Private container registry (ACR)
   - Network access controls via IP rules
   - Image retention policies

5. **Encryption**
   - TLS 1.2 minimum for storage
   - Encrypted storage accounts
   - Encrypted secrets in Key Vault

6. **Compliance**
   - Azure Policy enabled for governance
   - Audit logging via Azure Monitor

---

## Azure DevOps Branching Strategy

### Branching Model: Git Flow

The Traxxia application follows a **Git Flow** branching strategy, optimized for Azure DevOps with clear separation between development and production environments.

```
┌─────────────────────────────────────────────────────────────┐
│                    Branching Strategy                        │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│                        main/master                           │
│                          │                                   │
│                          │ (Production-ready code)            │
│                          │                                   │
│                    ┌──────┴──────┐                           │
│                    │             │                           │
│                  develop         hotfix/*                     │
│                    │             │                           │
│                    │     (Critical fixes)                    │
│                    │                                           │
│              ┌─────┴─────┐                                   │
│              │            │                                   │
│          feature/*    release/*                               │
│              │            │                                   │
│    (New features)  (Release prep)                             │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

### Branch Definitions

#### 1. **master/main Branch**
- **Purpose:** Production-ready code only
- **Protection:** 
  - Requires pull request for changes
  - Requires code review approval
  - No direct commits allowed
- **Trigger:** CD pipeline (manual trigger)
- **Deployment:** Production environment
- **Tagging:** Production releases tagged here

#### 2. **develop Branch**
- **Purpose:** Integration branch for all development work
- **Protection:**
  - Requires pull request for changes
  - Requires code review approval
  - No direct commits allowed
- **Trigger:** CI pipeline (automatic on PR merge)
- **Deployment:** Development environment (optional)
- **Merge Source:** Feature branches, hotfix branches

#### 3. **feature/* Branches**
- **Purpose:** Development of new features or enhancements
- **Naming Convention:** `feature/JIRA-123-short-description`
- **Source Branch:** `develop`
- **Merge Target:** `develop` (via Pull Request)
- **Lifecycle:**
  - Created from `develop`
  - Work completed and tested locally
  - Pull Request raised to `develop`
  - After review and approval, merged to `develop`
  - Branch deleted after merge

#### 4. **hotfix/* Branches**
- **Purpose:** Critical bug fixes for production
- **Naming Convention:** `hotfix/JIRA-456-critical-fix-description`
- **Source Branch:** `master`
- **Merge Target:** Both `master` and `develop`
- **Lifecycle:**
  - Created from `master`
  - Fix implemented and tested
  - Pull Request to `master` (fast-track approval)
  - After merge to `master`, also merged to `develop`
  - CD pipeline triggered manually from `master`

#### 5. **release/* Branches** (Optional)
- **Purpose:** Preparation for production releases
- **Naming Convention:** `release/v1.2.0`
- **Source Branch:** `develop`
- **Merge Target:** `master` and `develop`
- **Lifecycle:**
  - Created from `develop` when feature freeze
  - Bug fixes and release preparation
  - Final testing
  - Merged to `master` (tagged) and `develop`

### Branch Protection Rules

**For `master` branch:**
```
✓ Require pull request reviews (minimum 2 approvers)
✓ Require branch policies
✓ Require status checks to pass (CI pipeline)
✓ Require up-to-date branches before merge
✓ Block force pushes
✓ Block deletion
```

**For `develop` branch:**
```
✓ Require pull request reviews (minimum 1 approver)
✓ Require branch policies
✓ Require status checks to pass (CI pipeline)
✓ Block force pushes
✓ Block deletion
```

### Branching Workflow Example

**Feature Development:**
```
1. Developer creates feature branch from develop
   git checkout develop
   git pull origin develop
   git checkout -b feature/TRAX-100-user-authentication

2. Developer commits and pushes changes
   git commit -m "TRAX-100: Add user authentication"
   git push origin feature/TRAX-100-user-authentication

3. Developer creates Pull Request to develop
   - Fill PR description with changes
   - Request code review
   - Link to work item/JIRA ticket

4. Code review and approval
   - Reviewer reviews code
   - Comments and suggestions addressed
   - Approval given

5. Merge to develop
   - PR merged to develop
   - CI pipeline automatically triggered
   - Feature branch deleted (optional)
```

**Hotfix Process:**
```
1. Developer creates hotfix branch from master
   git checkout master
   git pull origin master
   git checkout -b hotfix/TRAX-200-security-patch

2. Fix implemented and tested
   git commit -m "TRAX-200: Fix security vulnerability"
   git push origin hotfix/TRAX-200-security-patch

3. Pull Request to master (expedited review)
   - Fast-track approval process
   - Merged to master

4. Merge to develop
   - Same changes merged to develop
   - Hotfix branch deleted

5. Trigger CD pipeline from master
   - Manual trigger with appropriate tags
```

### Repository Structure

**Three Separate Repositories:**
1. **traxxia-frontend** - Frontend application code
2. **traxxia-backend** - Backend API and services
3. **traxxia-ml-backend** - Machine learning backend services

**Each Repository Follows:**
- Same branching strategy
- Independent CI/CD pipelines
- Version tagging per repository
- Independent deployment cycles

---

## CI/CD Pipeline Architecture

### Continuous Integration (CI) Pipelines

CI pipelines are automatically triggered when Pull Requests are merged into the `develop` branch.

#### CI Pipeline Structure

```
┌─────────────────────────────────────────────────────────────┐
│                    CI Pipeline Flow                         │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  Trigger: PR Merge to develop                                │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Stage 1: Build & Test                                │   │
│  │ ┌─────────────────────────────────────────────────┐ │   │
│  │ │ - Checkout source code                          │ │   │
│  │ │ - Install dependencies                         │ │   │
│  │ │ - Run unit tests                               │ │   │
│  │ │ - Run linting/static analysis                  │ │   │
│  │ │ - Build application artifacts                  │ │   │
│  │ └─────────────────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────┘   │
│                         │                                    │
│                         ▼                                    │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Stage 2: Container Build                           │   │
│  │ ┌─────────────────────────────────────────────────┐ │   │
│  │ │ - Build Docker image                            │ │   │
│  │ │ - Tag image with build number                  │ │   │
│  │ │ - Run security scanning                        │ │   │
│  │ │ - Push to Azure Container Registry (ACR)       │ │   │
│  │ └─────────────────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────┘   │
│                         │                                    │
│                         ▼                                    │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Stage 3: Image Tagging                             │   │
│  │ ┌─────────────────────────────────────────────────┐ │   │
│  │ │ - Tag image with git commit SHA                │ │   │
│  │ │ - Tag image as 'latest' (develop)             │ │   │
│  │ │ - Store tag information for CD pipeline       │ │   │
│  │ └─────────────────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                               │
│  Output: Container image in ACR with tags                    │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

#### CI Pipeline Details by Service

##### Frontend CI Pipeline: `traxxia-dev-fe-ci`
- **Repository:** traxxia-frontend
- **Trigger:** PR merge to `develop`
- **Stages:**
  1. **Build & Test**
     - Install Node.js dependencies
     - Run unit tests
     - Run ESLint/TypeScript checks
     - Build production bundle
  2. **Container Build**
     - Build Docker image (e.g., `nginx` or `node` base)
     - Tag: `traxdevacr.azurecr.io/traxxia-frontend:$(Build.BuildId)`
     - Tag: `traxdevacr.azurecr.io/traxxia-frontend:latest`
     - Push to ACR
  3. **Publish Artifacts**
     - Publish build artifacts
     - Publish image tags for CD pipeline

**Pipeline URL:** https://dev.azure.com/mypiquota/Traxxia/_build?definitionId=[Frontend-CI-Id]

##### Backend CI Pipeline: `traxxia-dev-be-ci`
- **Repository:** traxxia-backend
- **Trigger:** PR merge to `develop`
- **Stages:**
  1. **Build & Test**
     - Install Python/Node.js dependencies (as applicable)
     - Run unit tests
     - Run code quality checks
     - Build application
  2. **Container Build**
     - Build Docker image
     - Tag: `traxdevacr.azurecr.io/traxxia-backend:$(Build.BuildId)`
     - Tag: `traxdevacr.azurecr.io/traxxia-backend:latest`
     - Push to ACR
  3. **Publish Artifacts**
     - Publish build artifacts
     - Publish image tags

**Pipeline URL:** https://dev.azure.com/mypiquota/Traxxia/_build?definitionId=[Backend-CI-Id]

##### ML Backend CI Pipeline: `traxxia-dev-mlbe-ci`
- **Repository:** traxxia-ml-backend
- **Trigger:** PR merge to `develop`
- **Stages:**
  1. **Build & Test**
     - Install ML dependencies (Python)
     - Run model tests
     - Run unit tests
     - Validate model artifacts
  2. **Container Build**
     - Build Docker image (may include model files)
     - Tag: `traxdevacr.azurecr.io/traxxia-ml-backend:$(Build.BuildId)`
     - Tag: `traxdevacr.azurecr.io/traxxia-ml-backend:latest`
     - Push to ACR
  3. **Publish Artifacts**
     - Publish model artifacts (if applicable)
     - Publish image tags

**Pipeline URL:** https://dev.azure.com/mypiquota/Traxxia/_build?definitionId=6

### Continuous Deployment (CD) Pipeline

The CD pipeline is manually triggered from the `master` branch and allows selective deployment of services.

#### CD Pipeline Structure: `traxxia-dev-app-cd`

```
┌─────────────────────────────────────────────────────────────┐
│                    CD Pipeline Flow                         │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  Trigger: Manual from master branch                          │
│                                                               │
│  Parameters:                                                  │
│  - frontendTag: Image tag for frontend                       │
│  - backendTag: Image tag for backend                         │
│  - mlbackendTag: Image tag for ML backend                    │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Stage 1: Deploy Frontend (Optional)                │   │
│  │ ┌─────────────────────────────────────────────────┐ │   │
│  │ │ - Pull image from ACR                           │ │   │
│  │ │ - Update Kubernetes deployment                  │ │   │
│  │ │ - Rolling update strategy                       │ │   │
│  │ │ - Health checks                                 │ │   │
│  │ │ - Rollback on failure                           │ │   │
│  │ └─────────────────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────┘   │
│                         │                                    │
│                         ▼                                    │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Stage 2: Deploy Backend (Optional)                 │   │
│  │ ┌─────────────────────────────────────────────────┐ │   │
│  │ │ - Pull image from ACR                           │ │   │
│  │ │ - Update Kubernetes deployment                  │ │   │
│  │ │ - Rolling update strategy                       │ │   │
│  │ │ - Health checks                                 │ │   │
│  │ │ - Database migrations (if applicable)           │ │   │
│  │ │ - Rollback on failure                           │ │   │
│  │ └─────────────────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────┘   │
│                         │                                    │
│                         ▼                                    │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Stage 3: Deploy ML Backend (Optional)              │   │
│  │ ┌─────────────────────────────────────────────────┐ │   │
│  │ │ - Pull image from ACR                           │ │   │
│  │ │ - Update Kubernetes deployment                  │ │   │
│  │ │ - Rolling update strategy                       │ │   │
│  │ │ - Model validation                              │ │   │
│  │ │ - Health checks                                 │ │   │
│  │ │ - Rollback on failure                           │ │   │
│  │ └─────────────────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                               │
│  Post-Deployment:                                            │
│  - Smoke tests                                               │
│  - Monitoring verification                                   │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

#### CD Pipeline Configuration

**Pipeline Name:** `traxxia-dev-app-cd`  
**Pipeline URL:** https://dev.azure.com/mypiquota/Traxxia/_build?definitionId=5

**Deployment Parameters:**

| Parameter | Type | Required | Description | Example |
|-----------|------|----------|-------------|---------|
| `frontendTag` | String | No | Frontend container image tag | `1.2.3` or `abc123def` |
| `backendTag` | String | No | Backend container image tag | `1.2.3` or `abc123def` |
| `mlbackendTag` | String | No | ML Backend container image tag | `1.2.3` or `abc123def` |

**Default Behavior:**
- If tag not specified, uses `latest` tag from ACR
- Allows selective deployment (only deploy what changed)
- Supports canary and blue-green deployment strategies (future enhancement)

**Stage Selection:**
- Developer can choose which stages to run
- Supports deployment of single service or multiple services
- Parallel deployment possible for independent services

### How to Get Image Tags

**From CI Pipeline Runs:**
1. Navigate to Azure DevOps → Pipelines
2. Select the respective CI pipeline (traxxia-dev-fe-ci, traxxia-dev-be-ci, traxxia-dev-mlbe-ci)
3. Open the completed build run
4. Check "Published Artifacts" or "Build Summary" for image tags
5. Copy the tag value (format: `Build.BuildId` or `git commit SHA`)

**From Azure Container Registry:**
1. Navigate to Azure Portal → Container Registries → traxdevacr
2. Select "Repositories"
3. Choose the repository (traxxia-frontend, traxxia-backend, traxxia-ml-backend)
4. View available tags
5. Select the desired tag

### Deployment Process Workflow

**Step-by-Step Deployment:**

```
1. Developer merges hotfix/release to master branch
   └─► Triggers no automatic pipeline

2. Developer navigates to CD pipeline
   └─► Selects "Run pipeline"

3. Developer selects:
   - Branch: master
   - Parameters:
     * frontendTag: [value or leave blank for latest]
     * backendTag: [value or leave blank for latest]
     * mlbackendTag: [value or leave blank for latest]
   - Stages to run: Select required stages

4. Pipeline execution:
   └─► Stages run in sequence (or selected stages only)

5. For each stage:
   └─► kubectl set image deployment/[service] [service]=acr/image:tag
   └─► kubectl rollout status deployment/[service]
   └─► Health check validation

6. Deployment completion:
   └─► All selected services deployed
   └─► Pipeline status: Succeeded

7. Post-deployment verification:
   └─► Application testing
   └─► Monitoring dashboards
```

---

## Deployment Strategies

### Current Strategy: Rolling Update

The current deployment uses Kubernetes' default **Rolling Update** strategy:

**Characteristics:**
- Zero-downtime deployments
- Gradual pod replacement
- Automatic rollback on health check failures
- Configurable surge and unavailable pod counts

**Configuration:**
```yaml
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxSurge: 25%
    maxUnavailable: 0
```

### Available Deployment Strategies

#### 1. Rolling Update (Current)
**Best For:** Standard deployments, continuous delivery

**Pros:**
- Zero downtime
- Simple configuration
- Automatic rollback
- Resource efficient

**Cons:**
- Brief period with mixed versions
- Cannot test new version before full rollout

#### 2. Blue-Green Deployment (Future)
**Best For:** Critical updates, production releases

**How it Works:**
- Deploy new version alongside current version
- Test new version thoroughly
- Switch traffic at once (via ingress)
- Keep old version for quick rollback

**Implementation:**
- Use separate Kubernetes deployments (blue/green)
- Configure ingress to route traffic
- Switch traffic via ingress annotation update

#### 3. Canary Deployment (Future)
**Best For:** Testing new versions with limited user base

**How it Works:**
- Deploy new version to small percentage of pods
- Monitor metrics and errors
- Gradually increase percentage
- Rollback if issues detected

**Implementation:**
- Use service mesh (Istio) or ingress controller
- Configure traffic splitting rules
- Monitor metrics via Prometheus/Grafana

#### 4. A/B Testing (Future)
**Best For:** Feature experimentation

**How it Works:**
- Deploy multiple versions simultaneously
- Route traffic based on user segments
- Compare metrics and performance
- Decide on winning version

### Recommended Deployment Strategy Roadmap

**Phase 1 (Current):** Rolling Update
- ✅ Implemented
- Suitable for current needs

**Phase 2 (To be plan):** Canary Deployment
- Add service mesh (Istio) or NGINX ingress advanced features
- Enable gradual rollout with monitoring
- Implement automatic rollback based on metrics

**Phase 3 (To be plan):** Blue-Green Deployment
- For critical production releases
- Implement with zero-downtime switchover
- Automated testing before traffic switch

### Deployment Best Practices

1. **Health Checks**
   - Configure liveness and readiness probes
   - Ensure proper timeout and period settings
   - Test health endpoints before deployment

2. **Resource Limits**
   - Set CPU and memory requests/limits
   - Prevent resource exhaustion
   - Enable proper auto-scaling

3. **Rollback Plan**
   - Maintain previous image tags
   - Document rollback procedure
   - Test rollback process regularly

4. **Pre-deployment Checks**
   - Run smoke tests
   - Validate configuration
   - Check dependencies availability

5. **Monitoring**
   - Monitor during and after deployment
   - Set up alerting for deployment failures
   - Track deployment metrics

---

## Monitoring & Alerting

### Current Monitoring Setup

**Azure Monitor Integration:**
- All AKS metrics automatically collected
- Container insights enabled
- Log Analytics workspace (implicit)

**Key Metrics Monitored:**
- CPU usage percentage
- Memory working set percentage
- Pod status and health
- Node availability

### Alert Configuration

#### CPU Usage Alert
- **Metric:** `node_cpu_usage_percentage`
- **Threshold:** > 95%
- **Evaluation:** Every 5 minutes
- **Window:** 5 minutes
- **Action:** Email notification to muthukumar@piquota.com

#### Memory Usage Alert
- **Metric:** `node_memory_working_set_percentage`
- **Threshold:** > 100%
- **Evaluation:** Every 5 minutes
- **Window:** 5 minutes
- **Action:** Email notification to muthukumar@piquota.com

### Monitoring Gaps & Recommendations

**Current Gaps:**
1. No application-level metrics monitoring
2. No log aggregation and analysis
3. No performance monitoring
4. No cost tracking alerts
5. Limited alerting scope

**Recommended Enhancements:**

1. **Application Insights Integration**
   - Add Azure Application Insights
   - Track application performance
   - Monitor request rates and errors
   - Track custom business metrics

2. **Log Aggregation**
   - Implement centralized logging
   - Use Azure Log Analytics or ELK stack
   - Structured logging from applications
   - Log retention policies

3. **Enhanced Alerting**
   - Pod restart alerts
   - Deployment failure alerts
   - API error rate alerts
   - Database connection alerts
   - Disk space alerts

4. **Cost Monitoring**
   - Set budget alerts
   - Track resource utilization
   - Optimize resource sizing

5. **Performance Monitoring**
   - Response time monitoring
   - Throughput tracking
   - Database query performance
   - Cache hit rates

---

## Future Enhancements

### Infrastructure Enhancements

#### 1. Multi-Region Deployment
**Timeline:** To be plan 
**Benefits:**
- Improved disaster recovery
- Reduced latency for global users
- Enhanced availability (99.99% SLA)

**Implementation:**
- Deploy AKS clusters in multiple regions
- Use Azure Traffic Manager or Front Door
- Replicate container images to regional ACRs
- Implement global load balancing

#### 2. Production Environment
**Timeline:** To be plan
**Current State:** Development environment only  
**Enhancement:**
- Separate production resource group
- Production AKS cluster with Standard SKU (SLA)
- Enhanced security policies
- Stricter access controls
- Production-grade monitoring

#### 3. Auto-Scaling Improvements
**Timeline:** To be plan  
**Enhancements:**
- Implement Horizontal Pod Autoscaler (HPA)
- Configure custom metrics for scaling
- Implement Cluster Autoscaler tuning
- Add predictive scaling using Azure ML

#### 4. Network Security Enhancements
**Timeline:** To be plan 
**Enhancements:**
- Implement Private Endpoints for ACR and Key Vault
- Restrict AKS API server access
- Implement Network Security Groups with stricter rules
- Add Web Application Firewall (WAF)
- Implement DDoS protection

#### 5. Backup & Disaster Recovery
**Timeline:** To be plan  
**Enhancements:**
- Implement Velero for Kubernetes backup
- Regular backup of cluster state
- Backup Key Vault secrets
- Backup Storage Account data
- Document and test DR procedures
- RTO/RPO targets definition

### CI/CD Enhancements

#### 1. Automated Testing in Pipeline
**Timeline:** To be plan 
**Enhancements:**
- Integration tests in CI pipeline
- End-to-end tests
- Performance tests
- Security scanning (vulnerability scanning)
- Container image scanning

#### 2. Deployment Automation
**Timeline:** To be plan  
**Enhancements:**
- Automatic deployment from develop to staging
- Canary deployment implementation
- Blue-green deployment support
- Automated rollback on failure
- Deployment gates (approvals)

#### 3. GitOps Implementation
**Timeline:** To be plan  
**Enhancements:**
- Implement Flux or ArgoCD
- Git-based configuration management
- Automated synchronization
- Configuration drift detection
- Declarative deployments

#### 4. Pipeline Optimization
**Timeline:** To be plan  
**Enhancements:**
- Parallel stage execution
- Cache dependencies
- Optimize build times
- Conditional stage execution
- Pipeline templates for reusability

### Security Enhancements

#### 1. Enhanced Secret Management
**Timeline:** To be plan  
**Enhancements:**
- Enable secret rotation
- Implement Azure Key Vault RBAC (migrate from access policies)
- Audit logging for secret access
- Secret versioning strategy

#### 2. Pod Security Policies
**Timeline:** To be plan  
**Enhancements:**
- Implement Pod Security Standards
- Enforce security contexts
- Restrict privileged containers
- Network policy enforcement

#### 3. Vulnerability Management
**Timeline:** To be plan  
**Enhancements:**
- Regular container image scanning
- Dependency vulnerability scanning
- Automated security updates
- Security compliance reporting

#### 4. Identity & Access Management
**Timeline:** To be plan  
**Enhancements:**
- Azure AD integration for Kubernetes RBAC
- Just-in-time access
- Privileged Identity Management (PIM)
- Regular access reviews

### Monitoring & Observability Enhancements

#### 1. Comprehensive Observability Stack
**Timeline:** To be plan  
**Components:**
- Prometheus for metrics
- Grafana for visualization
- Azure Application Insights
- Distributed tracing (Jaeger/Zipkin)
- Log aggregation (ELK or Azure Log Analytics)

#### 2. Advanced Alerting
**Timeline:** To be plan  
**Enhancements:**
- Multi-channel notifications (Slack, Teams, PagerDuty)
- Alert routing based on severity
- Alert grouping and deduplication
- Runbook automation

#### 3. Cost Optimization
**Timeline:** To be plan  
**Enhancements:**
- Cost tracking and budgeting
- Right-sizing recommendations
- Spot instances for non-critical workloads
- Resource utilization optimization

### Application Enhancements

#### 1. Service Mesh Implementation
**Timeline:** To be plan  
**Technology:** Istio or Linkerd  
**Benefits:**
- Advanced traffic management
- Service-to-service security
- Observability
- Canary deployments

#### 2. API Gateway
**Timeline:** To be plan  
**Options:** Azure API Management or Kong  
**Benefits:**
- Centralized API management
- Rate limiting
- Authentication/authorization
- API versioning

#### 3. Caching Layer
**Timeline:** To be plan  
**Options:** Redis Cache (Azure Cache for Redis)  
**Benefits:**
- Improved application performance
- Reduced database load
- Session management
- Distributed caching

#### 4. Message Queue
**Timeline:** To be plan  
**Options:** Azure Service Bus or Kafka  
**Benefits:**
- Asynchronous processing
- Event-driven architecture
- Decoupled services
- Better scalability

### Compliance & Governance

#### 1. Azure Policy Enforcement
**Timeline:** To be plan  
**Enhancements:**
- Custom policy definitions
- Resource tagging policies
- Naming convention policies
- Cost control policies

#### 2. Compliance Reporting
**Timeline:** To be plan  
**Enhancements:**
- Regular compliance audits
- Security posture reporting
- Resource inventory
- Configuration drift reports

---

## Appendix

### A. Resource Naming Conventions

**Naming Pattern:** `[environment]-[service]-[purpose]-[identifier]`

**Examples:**
- `trax-dev-aks` - Development AKS cluster
- `trax-dev-akv` - Development Key Vault
- `traxdevacr` - Development Container Registry (shortened)
- `traxdevasa` - Development Storage Account (shortened)
- `trax-dev-core-vnet` - Core virtual network

### B. ARM Template Deployment Commands

**Deploy Core Infrastructure:**
```bash
az deployment group create \
  --resource-group trax-dev-core-rg \
  --template-file trax-dev-core-rg/template.json \
  --parameters @trax-dev-core-rg/parameters.json
```

**Deploy Managed Resources:**
```bash
az deployment group create \
  --resource-group MC_trax-dev-core-rg_trax-dev-aks_centralus \
  --template-file MC_trax-dev-core-rg_trax-dev-aks_centralus/template.json \
  --parameters @MC_trax-dev-core-rg_trax-dev-aks_centralus/parameters.json
```

### C. Key Service URLs

- **Azure DevOps Organization:** https://dev.azure.com/mypiquota/Traxxia
- **Frontend Repository:** https://dev.azure.com/mypiquota/Traxxia/_git/traxxia-frontend
- **Backend Repository:** https://dev.azure.com/mypiquota/Traxxia/_git/traxxia-backend
- **ML Backend Repository:** https://dev.azure.com/mypiquota/Traxxia/_git/traxxia-ml-backend
- **Frontend CI Pipeline:** https://dev.azure.com/mypiquota/Traxxia/_build?definitionId=[Frontend-CI-Id]
- **Backend CI Pipeline:** https://dev.azure.com/mypiquota/Traxxia/_build?definitionId=[Backend-CI-Id]
- **ML Backend CI Pipeline:** https://dev.azure.com/mypiquota/Traxxia/_build?definitionId=6
- **CD Pipeline:** https://dev.azure.com/mypiquota/Traxxia/_build?definitionId=5

### D. Contact Information

**DevOps Team:**
- Email: muthukumar@piquota.com
- Azure DevOps: https://dev.azure.com/mypiquota/Traxxia

### E. Related Documentation

- [Azure Kubernetes Service Documentation](https://docs.microsoft.com/azure/aks/)
- [Azure Container Registry Documentation](https://docs.microsoft.com/azure/container-registry/)
- [Azure Key Vault Documentation](https://docs.microsoft.com/azure/key-vault/)
- [Azure DevOps Pipelines Documentation](https://docs.microsoft.com/azure/devops/pipelines/)

### F. Glossary

- **AKS:** Azure Kubernetes Service
- **ACR:** Azure Container Registry
- **AKV:** Azure Key Vault
- **ARM:** Azure Resource Manager
- **CI:** Continuous Integration
- **CD:** Continuous Deployment
- **IaC:** Infrastructure as Code
- **RBAC:** Role-Based Access Control
- **NSG:** Network Security Group
- **VNet:** Virtual Network
- **HPA:** Horizontal Pod Autoscaler
- **PR:** Pull Request
- **SKU:** Stock Keeping Unit (service tier)

---

## Document Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | October 2025 | Piquota DevOps Team | Initial document creation |

---

**End of Document**

