# CinemaOps Copilot

An AI-powered, real-time theater operations control system. Accepts natural-language commands from cinema admins ("Quarantine rows E8–F14, HVAC failure, relocate all parties to luxury recliners"), computes a constraint-satisfying seat relocation plan, gates on mandatory human approval, and executes an atomic database mutation — with live seat map updates pushed over WebSocket.

---

## Architecture

```
Admin Operator Console (React + TypeScript + Vite)
  │
  ├── Admin login → POST /api/v1/auth/login
  ├── Copilot     → POST /api/v1/agent/chat
  ├── Approval    → POST /api/v1/agent/resume
  └── Interactive seat map ← REST snapshot + WebSocket /ws/show/{id}

FastAPI Backend (Python 3.12)
  └── LangGraph StateGraph
        intent_parser  (role-scoped Groq Llama 3.3 70B — ReAct loop)
             ↓
        hitl_gate      (NodeInterrupt — graph pauses, state → MongoDB)
             ↓  (on admin approval)
        commit         (atomic MongoDB transaction via TransactionCoordinator)
             ↓
        broadcast      (RFC 6902 JSON Patch → Redis Pub/Sub → WebSocket)

Infrastructure
  ├── MongoDB Atlas — seat allocations, audit journal, LangGraph checkpoints
  └── Redis (Upstash)         — seat checkout locks, relocation holds, Pub/Sub
```

### Key Design Decisions

- **The LLM cannot write to the database.** The tool registry exposes 3 read-only tools and 1 plan-only tool. No write tool exists.
- **The agent is an operations controller, not a general chatbot.** It handles show incidents, occupancy, seat impact, and relocation planning. Out-of-role requests are declined.
- **Interactive seat map.** Operators can select seats to inspect current status, tier, and booking assignment. Selection is informational; it does not mutate live allocations.
- **Authentication is separate from show selection.** Admins sign in with email/password to obtain a short-lived JWT, then connect to an actual show ID.
- **HITL gate uses `NodeInterrupt`**, not a conditional edge — full graph state is persisted to MongoDB. Any pod can resume a paused workflow.
- **Spatial Adjacency Solver** is a deterministic Bin-Packing + 1D Sliding Window algorithm. The LLM asks the solver; the solver's answer is ground truth.
- **Redlock-compatible seat locking** via Redis `SET NX PX` with a Lua-script release guard — prevents stale lock deletion across pods.
- **Append-only audit journal** — rollback writes a compensating entry and marks the original, never deletes audit history.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Agent orchestration | LangGraph 0.2.52 + `langgraph-checkpoint-mongodb` |
| LLM | Groq Cloud — Llama 3.3 70B |
| Web framework | FastAPI 0.115.5 + Uvicorn 0.32.0 |
| Database | MongoDB Atlas via Motor/PyMongo |
| Caching / locking | Redis 4.6.0 (Redlock-compatible; required by Pottery 3.0.0) |
| Auth | JWT HS256 via `python-jose` |
| Config | `pydantic-settings` (fail-fast env validation) |
| Logging | `structlog` (structured JSON) |
| Frontend | TypeScript + Vite + React components |
| Linter | `ruff` |
| Tests | `pytest` + `pytest-asyncio` |

---

## Project Structure

```
cinemaops/
├── backend/
│   ├── app/
│   │   ├── agent/
│   │   │   ├── graph.py          # LangGraph StateGraph definition
│   │   │   ├── state.py          # CinemaOpsState TypedDict
│   │   │   ├── tools.py          # LLM tool registry (authority matrix)
│   │   │   └── nodes/
│   │   │       ├── intent_parser.py  # ReAct loop node
│   │   │       ├── hitl_gate.py      # NodeInterrupt checkpoint
│   │   │       ├── commit_node.py    # Atomic DB mutation
│   │   │       └── broadcast_node.py # WebSocket fanout
│   │   ├── services/
│   │   │   ├── spatial_solver.py     # Bin-packing seat placement algorithm
│   │   │   ├── lock_manager.py       # Redis Redlock seat fencing
│   │   │   ├── transaction_svc.py    # Atomic mutation orchestrator
│   │   │   └── sdui_publisher.py     # RFC 6902 JSON Patch publisher
│   │   ├── db/
│   │   │   └── mongodb_client.py     # Queries, transactions, indexes
│   │   ├── routers/
│   │   │   ├── agent.py   # /api/v1/agent/* endpoints
│   │   │   ├── seats.py   # /api/v1/seats/* endpoints
│   │   │   └── ws.py      # /ws/show/{id} WebSocket
│   │   ├── models/
│   │   │   ├── domain.py  # Pydantic domain models + error types
│   │   │   └── api.py     # Request/response schemas
│   │   ├── middleware/
│   │   │   └── auth.py    # JWT HS256 admin auth
│   │   ├── config.py      # pydantic-settings (fail-fast)
│   │   ├── main.py        # FastAPI app + lifespan
│   │   └── redis_client.py
│   ├── tests/
│   │   └── test_spatial_solver.py
│   ├── pyproject.toml
│   └── .env.example
└── frontend/
    ├── src/
    │   ├── components/
    │   │   ├── ChatPanel/ChatPanel.tsx
    │   │   ├── HitlModal/HitlModal.tsx   # Side-by-side visual diff
    │   │   └── SeatMap/SeatMap.tsx        # Real-time seat grid
    │   ├── hooks/
    │   │   ├── useWebSocket.ts            # WS + JSON Patch + reconnect
    │   │   └── useAgentSession.ts         # Agent state machine hook
    │   ├── api/client.ts
    │   └── types/sdui.ts                 # RFC 6902 + WS event types
    ├── package.json
    └── tsconfig.json
```

---

## Setup

### Prerequisites
- Python 3.12+
- Node.js 20+
- A MongoDB Atlas cluster (a replica set is required for transactions)
- A Redis instance (Upstash free tier works)
- A Groq Cloud API key

### Backend

```bash
cd backend

# Create virtual environment
python -m venv .venv
.venv\Scripts\activate        # Windows
# source .venv/bin/activate   # macOS/Linux

# Install dependencies
pip install -e ".[dev]"

# Configure environment
cp .env.example .env
# Edit .env with your MongoDB URI/database, Redis URL, Groq key, and JWT secret
# ALLOWED_ORIGINS must be a JSON array, for example ["http://localhost:5173"]

# Start the server
uvicorn app.main:app --reload
```

### Frontend

```bash
cd frontend
npm install

# Configure environment
echo "VITE_API_URL=http://localhost:8000" > .env.local
echo "VITE_WS_URL=ws://localhost:8000" >> .env.local

npm run dev
```

### Run Tests

```bash
cd backend
pytest tests/ -v
```

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/agent/chat` | Submit natural-language command |
| `POST` | `/api/v1/agent/resume` | Approve paused graph (HITL) |
| `GET` | `/api/v1/agent/status/{thread_id}` | Poll graph state |
| `POST` | `/api/v1/agent/undo` | Rollback a committed journal entry |
| `GET` | `/api/v1/agent/audit` | Operational audit log |
| `WS` | `/ws/show/{show_id}` | Real-time seat map updates |
| `GET` | `/health` | Health check |
| `POST` | `/api/v1/auth/login` | Exchange admin email/password for a JWT |

---

## Guardrails

| Rule | Enforcement |
|---|---|
| LLM cannot write to DB | No write tool in `ALL_TOOLS` registry |
| No tier downgrade | `InvariantViolationError` in solver |
| No party split | Sliding window must fit entire party |
| Per-voucher fiscal cap | `validate_fiscal_guardrails()` |
| Daily budget cap | `validate_fiscal_guardrails()` |
| No double-booking | Unique MongoDB index on `(show_id, seat_id)` |
| Atomic rollback | MongoDB transaction + compensating journal entry |
| Admin approval required | LangGraph `NodeInterrupt` — cannot be bypassed |

---

## License

MIT

