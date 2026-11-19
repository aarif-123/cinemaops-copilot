
import asyncio
from pathlib import Path
from dotenv import load_dotenv

from langchain_groq import ChatGroq
from langchain_core.messages import HumanMessage

from app.agent.tools import inspect_seat_cluster
from app.agent.tools import ALL_TOOLS
from app.config import get_settings


# Load backend/.env
backend_dir = Path(__file__).resolve().parents[3]
load_dotenv(backend_dir / ".env")


async def main():
    settings = get_settings()

    print("MODEL:", settings.groq_model)

    llm = ChatGroq(
        api_key=settings.groq_api_key,
        model=settings.groq_model,
        temperature=0,
    ).bind_tools(ALL_TOOLS)
    response = await llm.ainvoke([
        HumanMessage(
            content="""
            Show ID: screen-4
            A technical issue has been reported affecting seats J1 through J10.
            Inspect these seats, check for active Redis locks,
            and generate a relocation plan if the safety checks pass.
            Target tier: PRIME
            Compensation: FNB_VOUCHER_200
            Use only the registered tools."""
        )
    ])

    print("TOOL CALLS:", response.tool_calls)
    print("INVALID TOOL CALLS:", response.invalid_tool_calls)


if __name__ == "__main__":
    asyncio.run(main())
