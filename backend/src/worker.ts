import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function run(): Promise<void> {
  // Placeholder worker loop.
  // In next iteration this should process Redis/BullMQ jobs.
  setInterval(async () => {
    await prisma.sessionEvent.create({
      data: {
        sessionId: "00000000-0000-0000-0000-000000000000",
        eventType: "worker_heartbeat",
        payload: { ts: new Date().toISOString() },
      },
    }).catch(() => {
      // Ignore for placeholder; may fail if session doesn't exist.
    });
  }, 60000);
}

run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
