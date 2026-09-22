# Support Agent Flow Documentation

This document describes the complete workflow of the Support Agent system, which automates customer support ticket enrichment by cross-referencing customer data from the Acme database.

## System Overview

```mermaid
graph TB
    subgraph "External Triggers"
        WH[Webhook Trigger<br/>conversation.created]
    end

    subgraph "Support Agent System"
        EP[Entry Point]
        CV[Conversation Processor]
        CL[Acme Lookup Service]
        PE[Property Enricher]
        TG[Tagger Service]
        NT[Note Creator]
    end

    subgraph "External APIs"
        HS[Help Scout API]
        CJ[Acme GraphQL API]
    end

    WH --> EP
    EP --> CV
    CV --> HS
    CV --> CL
    CL --> CJ
    CL --> PE
    PE --> HS
    PE --> TG
    TG --> HS
    TG --> NT
    NT --> HS
```

## High-Level Workflow

```mermaid
sequenceDiagram
    participant W as Webhook
    participant S as Support Agent
    participant H as Help Scout API
    participant C as Acme API

    W->>S: conversation.created event
    S->>H: Get conversation details
    H-->>S: Conversation + Customer data
    S->>C: Search organizations by email
    C-->>S: Organization data (ENDUSER/DESIGN)

    opt If DESIGN org exists
        S->>C: Get marketplace integrations
        C-->>S: Etsy, Shopify, WooCommerce URLs
    end

    S->>H: Update customer properties
    S->>H: Tag conversation
    S->>H: Create research note
    S-->>W: Processing complete
```

## Detailed Process Flow

### Phase 1: Webhook Reception & Initialization

```mermaid
flowchart TD
    A[Webhook Received] --> B{Validate Payload}
    B -->|Invalid| C[Return Error Response]
    B -->|Valid| D[Extract Conversation ID]
    D --> E[Extract Customer Email]
    E --> F[Initialize API Clients]
    F --> G[Authenticate with Help Scout]
    G --> H{Auth Success?}
    H -->|No| I[Log Error & Return]
    H -->|Yes| J[Proceed to Processing]
```

**Webhook Payload Structure:**
```json
{
  "id": 123456789,
  "type": "conversation.created",
  "record": {
    "id": 123456789,
    "number": 12345,
    "type": "email",
    "mailboxId": 100001,
    "status": "active",
    "subject": "Help with...",
    "primaryCustomer": {
      "id": 423735212,
      "email": "customer@example.com"
    }
  }
}
```

### Phase 2: Customer Data Lookup

```mermaid
flowchart TD
    A[Customer Email Extracted] --> B[Query Acme API]
    B --> C{Organizations Found?}
    C -->|No| D[Mark as Not Found]
    C -->|Yes| E[Parse Organization Data]
    E --> F{Check Org Types}
    F --> G[ENDUSER Only]
    F --> H[DESIGN Only]
    F --> I[Both ENDUSER & DESIGN]
    G --> J[Determine Account Type]
    H --> J
    I --> J
    J --> K[Extract Primary Org ID]
    K --> L[Extract Contact Email]
    L --> M[Extract Ordway/Plan ID]
    M --> N[Extract Affiliate Status]
```

**Organization Types:**
| Type | Description | Properties Available |
|------|-------------|---------------------|
| ENDUSER | End customer/buyer account | orgId, name, status, contactEmail, orderCount |
| DESIGN | Designer/seller account | orgId, name, status, contactEmail, planId, affiliateStatus, integrations |

### Phase 3: Integration Data Retrieval (Designers Only)

```mermaid
flowchart TD
    A{Is DESIGN Org?} -->|No| B[Skip Integration Lookup]
    A -->|Yes| C[Query Etsy Integrations]
    C --> D[Query Shopify Integrations]
    D --> E[Query WooCommerce Integrations]
    E --> F[Parse Integration Attributes]
    F --> G[Extract Shop URLs]
    G --> H[Compile Integration Data]
```

**Integration Sources:**
| Source | URL Field | Attributes JSON Key |
|--------|-----------|-------------------|
| Etsy | shop_url | `attributes.shop_url` |
| Shopify | myshopify_domain | `attributes.shop_url` or domain |
| WooCommerce | site_url | `attributes.shop_url` or site_url |

### Phase 4: Customer Property Enrichment

```mermaid
flowchart TD
    A[Fetch Existing Properties] --> B{Property Already Set?}
    B -->|Yes| C{Is Affiliate Field?}
    C -->|No| D[Skip - Already Has Value]
    C -->|Yes| E{Value Changed?}
    E -->|No| D
    E -->|Yes| F[Add to Update List]
    B -->|No| G{New Value Available?}
    G -->|No| H[Skip - No Value Found]
    G -->|Yes| F
    F --> I[Build JSON Patch]
    I --> J[Send Property Update]
    J --> K[Log Update Results]
```

**Customer Properties Updated:**
| Property Name | Slug | Source | Update Logic |
|--------------|------|--------|--------------|
| Account Type | account-type | Org types | Set once |
| Affiliate | affiliate | affiliateAccountId or status | Always update if changed |
| Org ID | org-id | Primary org ID | Set once |
| Org/Contact Email | org-contact-email | Org contact email | Set once |
| Ordway ID | ordway-id | planId | Set once |
| Etsy Shop | etsy-shop | Integration attributes | Set once |
| Shopify Shop | shopify-shop | Integration attributes | Set once |
| WooCommerce Shop | woocommerce-shop | Integration attributes | Set once |

### Phase 5: Conversation Tagging

```mermaid
flowchart TD
    A[Get Existing Tags] --> B{DESIGN Org Found?}
    B -->|Yes| C[Add 'acme seller' Tag]
    B -->|No| D{ENDUSER Org Found?}
    D -->|Yes| E[Add 'acme customer' Tag]
    D -->|No| F[No Tag Added]
    C --> G[Preserve Existing Tags]
    E --> G
    G --> H[Update Conversation Tags]
```

### Phase 6: Research Note Creation

```mermaid
flowchart TD
    A[Compile Research Data] --> B[Format Note Header]
    B --> C{Customer Found?}
    C -->|Yes| D[Add 'Customer Found']
    C -->|No| E[Add 'Not found']
    D --> F[Add Customer Type]
    E --> G[Create Note]
    F --> H{Has ENDUSER Org?}
    H -->|Yes| I[Add End User Link]
    H -->|No| J{Has DESIGN Org?}
    I --> J
    J -->|Yes| K[Add Designer Link]
    J -->|No| L{Has Orders?}
    K --> L
    L -->|Yes| M[Add Recent Order Link]
    L -->|No| G
    M --> G
```

**Note Format:**
```
Research results:
Customer Found
Customer type: Designer & Customer

End User Profile: https://intranet.acme.example/support/end-users/{orgId}
Designer Profile: https://intranet.acme.example/support/designers/{orgId}
Recent Order: https://intranet.acme.example/support/orders/{orderId}
```

## Complete End-to-End Flow

```mermaid
stateDiagram-v2
    [*] --> WebhookReceived
    WebhookReceived --> ValidatePayload
    ValidatePayload --> ExtractCustomerEmail: Valid
    ValidatePayload --> Error: Invalid
    ExtractCustomerEmail --> AuthenticateAPIs
    AuthenticateAPIs --> SearchAcmeOrganizations
    SearchAcmeOrganizations --> ProcessOrganizations: Found
    SearchAcmeOrganizations --> CreateNotFoundNote: Not Found
    ProcessOrganizations --> CheckDesignerOrg
    CheckDesignerOrg --> FetchIntegrations: Has DESIGN
    CheckDesignerOrg --> SkipIntegrations: No DESIGN
    FetchIntegrations --> UpdateCustomerProperties
    SkipIntegrations --> UpdateCustomerProperties
    UpdateCustomerProperties --> TagConversation
    TagConversation --> CreateResearchNote
    CreateResearchNote --> [*]
    CreateNotFoundNote --> TagConversation
    Error --> [*]
```

## Data Flow Diagram

```mermaid
graph LR
    subgraph "Input"
        A[Webhook Payload]
    end

    subgraph "Processing"
        B[Customer Email]
        C[Conversation ID]
        D[Customer ID]
    end

    subgraph "Acme Data"
        E[Organization IDs]
        F[Account Types]
        G[Contact Info]
        H[Affiliate Data]
        I[Plan/Ordway ID]
        J[Integration URLs]
    end

    subgraph "Output"
        K[Updated Properties]
        L[Conversation Tags]
        M[Research Note]
    end

    A --> B
    A --> C
    A --> D
    B --> E
    E --> F
    E --> G
    E --> H
    E --> I
    E --> J
    F --> K
    G --> K
    H --> K
    I --> K
    J --> K
    F --> L
    E --> M
    F --> M
```

## Error Handling Flow

```mermaid
flowchart TD
    A[Operation] --> B{Success?}
    B -->|Yes| C[Continue Flow]
    B -->|No| D{Retryable?}
    D -->|Yes| E[Retry with Backoff]
    E --> F{Max Retries?}
    F -->|No| A
    F -->|Yes| G[Log Error]
    D -->|No| G
    G --> H{Critical?}
    H -->|Yes| I[Halt Processing]
    H -->|No| J[Continue with Partial Data]
    I --> K[Return Error Response]
    J --> C
```

**Error Categories:**
| Category | Examples | Handling |
|----------|----------|----------|
| Authentication | Token expired, Invalid credentials | Retry with refresh |
| Network | Timeout, Connection refused | Retry with exponential backoff |
| API Errors | 400/404 responses | Log and continue |
| Data Issues | Missing fields, Invalid format | Use defaults, continue |
| Critical | 500 errors, Service unavailable | Halt and return error |

## Performance Considerations

```mermaid
gantt
    title Typical Processing Timeline
    dateFormat X
    axisFormat %Lms

    section Authentication
    Auth Token Check    :0, 50

    section Help Scout
    Get Conversation    :50, 150

    section Acme
    Search Orgs         :150, 300
    Get Integrations    :300, 500

    section Updates
    Update Properties   :500, 600
    Update Tags         :600, 700
    Create Note         :700, 800
```

**Key Metrics:**
- Average processing time: 500-800ms
- API calls per request: 4-7 (depending on integrations)
- Retry attempts: Up to 3 per operation
- Token cache duration: ~2 days (with 60s buffer)
