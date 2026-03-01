import asyncio
import websockets

async def handler(websocket):
    pass

async def main():
    async with websockets.serve(handler, "localhost", 8101):
        print("ws server started")
        # await asyncio.sleep(1)

asyncio.run(main())
