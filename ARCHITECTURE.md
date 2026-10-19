# ITCake Architecture Diagram

```mermaid
graph TB
    subgraph "External"
        Browser["🌐 Browser"]
        Agent["🤖 Go Agent\n(macOS/Linux/Windows)"]
        Proxy["🔒 Reverse Proxy\n(Caddy/nginx/Cloudflare)"]
        SMTP["📧 SMTP Server"]
        Telegram["📱 Telegram Bot"]
        Anthropic["🤖 Anthropic API"]
        Uptime["🌍 Uptime Targets"]
    end

    Proxy -->|TLS Termination| Server["🟢 Node.js Server\nSvelteKit 3 + adapter-node"]

    subgraph "Server"
        Server -->|API| API["/api/*"]
        Server -->|Pages| UI["/(app)/*"]
    end

    subgraph "Core Services"
        Auth["🔐 Auth\nSessions + MFA + Step-up"]
        Audit["📜 Audit Log\nHMAC Chain + Anchor"]
        Crypto["🔐 Field Crypto\nAES-256-GCM + AAD"]
        Rate["🚦 Rate Limit\nPer-IP/Email/Global"]
    end

    subgraph "Business Logic"
        Invoices["📄 Invoices\n+ Credit Notes + Proposals"]
        Tickets["🎫 Tickets\nTime Tracking → Invoice"]
        UptimeSvc["📊 Uptime\nPing/HTTP/SSL/Domain"]
        Clients["👥 Clients + Catalog"]
        Reports["📈 Reports\nRevenue/Tax/Client"]
        Backups["💾 Backups\nZIP + AES-256-GCM"]
        RMM["🤖 RMM Agent Mgmt\nCheckin/Commands/Updates"]
        Remote["🖥️ Remote Desktop\nGuacamole (guacd)"]
        Alerts["🚨 Alert Rules\nTelegram/Email"]
        AI["🤖 AI Assistant\nTools + Budget"]
    end

    subgraph "Storage"
        DB[("🗄️ SQLite\nbetter-sqlite3 WAL")]
        Files["📁 DATA_DIR\nUploads/Backups/Agent bins"]
    end

    %% Connections
    API --> Auth
    API --> Audit
    API --> Crypto
    API --> Rate
    
    Auth --> Invoices
    Auth --> Tickets
    Auth --> UptimeSvc
    Auth --> Clients
    Auth --> Reports
    Auth --> Backups
    Auth --> RMM
    Auth --> Remote
    Auth --> Alerts
    Auth --> AI

    Invoices --> DB
    Tickets --> DB
    UptimeSvc --> DB
    Clients --> DB
    Reports --> DB
    Backups --> DB
    RMM --> DB
    Remote --> DB
    Alerts --> DB
    AI --> DB

    Backups --> Files
    RMM --> Files
    Remote --> Files

    %% External integrations
    Server -.->|TLS Pinning| Agent
    Agent -.->|Bearer + HMAC| Server
    Server -.->|SMTP| SMTP
    Server -.->|Bot API| Telegram
    Server -.->|Messages| Anthropic
    Server -.->|Ping/HTTP/SSL/RDAP| Uptime
    Server -.->|Pinning| SMTP
    Server -.->|Pinning| Telegram
    Server -.->|Pinning| Anthropic
```

---

## Component Overview

```mermaid
graph TB
    subgraph "External"
        Browser["🌐 Browser\n(User UI)"]
        Agent["🤖 Go Agent\n(RMM Agent)"]
        External["🔗 External Services\nSMTP / Telegram / AI"]
    end

    Proxy["🔒 Reverse Proxy\n(Caddy/nginx)\nTLS Termination + Rate Limit"]
    
    subgraph "Node.js Server (SvelteKit 3)"
        Core["Core Services\n🔐 Auth (MFA + Step-up)\n📜 Audit (HMAC Chain)\n🔐 Crypto (AES-256-GCM + AAD)\n🚦 Rate Limit (Per-IP/Email/Global)"]
        
        Biz["Business Logic Services\n📄 Invoices\n🎫 Tickets\n📊 Uptime\n👥 Clients\n📈 Reports\n💾 Backups\n🤖 RMM\n🖥️ Remote Desktop\n🚨 Alerts\n🤖 AI Assistant"]
    end
    
    Storage["Storage Layer\n🗄️ SQLite (WAL)\nbetter-sqlite3\n📁 DATA_DIR\nUploads/Backups/Agent bins"]
    
    ExternalDB[("🗄️ SQLite\nbetter-sqlite3 WAL")]
    ExternalFiles["📁 DATA_DIR\nUploads/Backups/Agent bins"]
```

```mermaid
graph LR
    Browser --> Proxy
    Agent -.->|TLS Pinning + Bearer + HMAC| Server
    Server -.->|TLS Pinning| External
    Server -.->|SMTP| SMTP
    Server -.->|Bot API| Telegram
    Server -.->|Messages| Anthropic
    Server -.->|Ping/HTTP/SSL/RDAP| Uptime
    Server -.->|Pinning| SMTP
    Server -.->|Pinning| Telegram
    Server -.->|Pinning| Anthropic
    
    Proxy --> Server["Node.js Server\nSvelteKit 3 + adapter-node"]
    Server --> Core
    Server --> Biz
    Core --> Biz
    Biz --> Storage
    Storage --> DB[("SQLite\nbetter-sqlite3 WAL")]
    Storage --> Files["📁 DATA_DIR\nUploads/Backups/Agent bins"]
```

---

## Data Flow: Agent Check-in

```mermaid
sequenceDiagram
    participant Agent as Go Agent
    participant Proxy as Reverse Proxy
    participant Server as Node Server
    participant DB as SQLite
    participant Audit as Audit Log

    Agent->>Proxy: HTTPS POST /api/rmm/checkin (Bearer + HMAC)
    Proxy->>Server: Forward request
    Server->>Server: authenticateAgent() → verify HMAC
    Server->>Server: authenticateAgent() → verify HMAC
    Server->>Server: processCheckin() → metrics, events, packages
    Server->>DB: Transaction: insert metrics, events, commands
    Server->>Audit: recordChange() in same transaction
    Server->>Server: getPendingCommands()
    Server->>Agent: JSON response { commands: [...] }
    Agent->>Agent: Execute commands (HMAC-signed payloadRaw)
    Agent->>Server: POST /api/agents/[id]/commands { result }
```

---

## Security Layers

| Layer | Controls |
|-------|----------|
| **Network** | TLS 1.3 + Pinned TLS (Agent)<br/>HSTS + CSP + COOP/CORP + Permissions-Policy<br/>Reverse Proxy Rate Limit |
| **Application** | Session: HMAC-SHA256 + Secure/HttpOnly<br/>MFA: TOTP + Recovery Codes<br/>Step-Up: MFA code required for sensitive actions<br/>CSRF: Origin/Referer + SameSite=Strict |
| **Authorization** | `requireUser` / `requireAdmin`<br/>MFA Step-Up on sensitive actions<br/>Agent: Bearer + HMAC per command |
| **Data** | Field-level AES-256-GCM + AAD<br/>scrypt N=131072 key derivation<br/>Backup: separate passphrase + AES-256-GCM<br/>Agent tokens: separate pepper |
| **Audit** | HMAC-SHA256 chained log<br/>Anchor + History snapshots<br/>Truncation detection |

---

## Data Flow: Agent Check-in

```mermaid
sequenceDiagram
    participant Agent as Go Agent
    participant Proxy as Reverse Proxy
    participant Server as Node Server
    participant DB as SQLite
    participant Audit as Audit Log

    Agent->>Proxy: HTTPS POST /api/rmm/checkin (Bearer + HMAC)
    Proxy->>Server: Forward request
    Server->>Server: authenticateAgent() → verify HMAC
    Server->>Server: authenticateAgent() → verify HMAC
    Server->>Server: processCheckin() → metrics, events, packages
    Server->>DB: Transaction: insert metrics, events, commands
    Server->>Audit: recordChange() in same transaction
    Server->>Server: getPendingCommands()
    Server->>Agent: JSON response { commands: [...] }
    Agent->>Agent: Execute commands (HMAC-signed payloadRaw)
    Agent->>Server: POST /api/agents/[id]/commands { result }
```

---

## Data Model (Simplified)

```mermaid
erDiagram
    USER ||--o{ SESSION : has
    USER ||--o{ MFA : has
    USER ||--o{ AUDIT_LOG : performs
    
    CLIENT ||--o{ INVOICE : receives
    CLIENT ||--o{ PROPOSAL : receives
    CLIENT ||--o{ TICKET : owns
    CLIENT ||--o{ EXPENSE : incurs
    
    INVOICE ||--o{ LINE_ITEM : contains
    INVOICE ||--o{ DISCOUNT : has
    INVOICE ||--o{ CREDIT_NOTE : generates
    
    PROPOSAL ||--o{ LINE_ITEM : contains
    PROPOSAL ||--o{ DISCOUNT : has
    PROPOSAL }|--o{ INVOICE : converts_to
    
    TICKET ||--o{ TIME_ENTRY : logs
    TICKET }|--o{ INVOICE : converts_to
    
    MONITOR ||--o{ CHECK : generates
    MONITOR ||--o{ INCIDENT : triggers
    ALERT_RULE ||--o{ NOTIFICATION : triggers
    
    AGENT ||--o{ METRIC : reports
    AGENT ||--o{ EVENT : generates
    AGENT ||--o{ FINDING : has
    AGENT ||--o{ COMMAND : receives
    AGENT ||--o{ SCHEDULE : runs
    
    BACKUP ||--o{ VERIFICATION : undergoes
    SETTINGS ||--o{ CREDENTIAL : encrypts
```

---

## Quick Reference: Key Files

| Layer | Key Files |
|-------|-----------|
| **Entry** | `src/routes/+layout.server.ts`, `src/hooks.server.ts` |
| **Auth** | `src/lib/server/auth.ts`, `src/lib/server/mfa-step-up.ts` |
| **Audit** | `src/lib/server/changes.ts`, `src/lib/server/db.ts` |
| **Crypto** | `src/lib/server/field-crypto.ts`, `src/lib/secret-mask.ts` |
| **Rate Limit** | `src/lib/server/rate-limit.ts` |
| **Services** | `src/services/*.ts` (27 files) |
| **API** | `src/routes/api/**/+server.ts` |
| **UI** | `src/routes/(app)/**/+page.svelte`, `src/lib/components/**` |
| **Agent** | `agent/cmd/agent/`, `agent/internal/*` |
| **Tests** | `tests/unit/*.test.ts`, `tests/integration/lifecycle.test.ts` |

---

*Generated for ITCake v0.1.0 — Architecture as of 2026-10-19*