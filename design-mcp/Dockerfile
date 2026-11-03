# design-mcp: the STAR design-tools MCP server (README.md).
#
# One small Python process. It holds no data of its own beyond the file cache
# (a volume at /cache) and reaches every app over the compose network.
FROM python:3.12-slim
WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY star_design_mcp/ ./star_design_mcp/

# matplotlib writes its font cache on first use; keep it off the read-only layers.
ENV MPLCONFIGDIR=/tmp/matplotlib \
    DESIGN_MCP_PORT=8010 \
    PYTHONUNBUFFERED=1

RUN useradd --system --uid 10010 mcp && mkdir -p /cache && chown mcp /cache
USER mcp

EXPOSE 8010
CMD ["python", "-m", "star_design_mcp"]
