#!/usr/bin/env node
// Demo data for a local STARProject (npm run dev:local runs this). It mirrors
// the real project tree (LE4 and its subprojects, SSEP3, Luna) and puts BOM
// lines on it taken from LE3 BOM.xlsx, in every state a line can be in, so the
// BOM tab has something to show at every level. Runs once: a database that
// already has an LE4 is left alone. Refuses to touch anything but localhost.

import { PrismaClient } from "@prisma/client";

const url = process.env.DATABASE_URL ?? "";
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  console.error("seed-local: DATABASE_URL is not a localhost database; refusing to seed.");
  process.exit(1);
}

const prisma = new PrismaClient();
const devEmail = (process.env.DEV_AUTH_EMAIL ?? "dev@berkeley.edu").toLowerCase();
const devName = process.env.DEV_AUTH_NAME ?? "Dev User";

async function main() {
  if (await prisma.project.findFirst({ where: { name: "LE4", parentId: null } })) {
    console.log("seed-local: demo data already there (npm run dev:local -- --reset to start over).");
  } else {
    await seedDemo();
  }
  await seedPurchasing();
}

// You are a PVP locally (so approving can be tried), and there are two demo
// purchase requests. Safe to run on an existing database: it adds only what is
// missing, so a database seeded before purchase requests existed catches up.
async function seedPurchasing() {
  await prisma.pvpEmail.upsert({ where: { email: devEmail }, create: { email: devEmail }, update: {} });
  if (await prisma.purchaseRequest.count()) return;
  const sam = await prisma.user.findUnique({ where: { email: "sam.rivera@berkeley.edu" } });
  const dev = await prisma.user.findUnique({ where: { email: devEmail } });
  const le4 = await prisma.project.findFirst({ where: { name: "LE4", parentId: null } });
  if (!sam || !dev || !le4) return;
  const lines = await prisma.bomItem.findMany({
    where: { name: { in: ["Drogue", "Shockcord (200 ft)", "M2500 Motor"] } },
    include: { project: { select: { name: true } } },
  });
  const snap = (l, position) => ({
    bomItemId: l.id,
    projectId: l.projectId,
    projectName: l.project.name,
    kind: l.kind,
    name: l.name,
    partNumber: l.partNumber,
    manufacturer: l.manufacturer,
    unitCostCents: l.unitCostCents,
    quantity: l.quantity,
    shippingCents: l.shippingCents,
    url: l.url,
    // The cost rule (src/lib/bom.ts predictedCents), written out for a .mjs script.
    predictedCents:
      l.kind === "allowance"
        ? (l.unitCostCents ?? 0)
        : Math.round((l.unitCostCents ?? 0) * (l.quantity ?? 1)) + (l.shippingCents ?? 0),
    position,
  });
  const recovery = lines.filter((l) => l.name !== "M2500 Motor" && l.status === "planned");
  if (recovery.length) {
    await prisma.purchaseRequest.create({
      data: {
        projectId: recovery[0].projectId,
        note: "Need these before the December ground test.",
        createdById: sam.id,
        items: { create: recovery.map(snap) },
      },
    });
  }
  const motor = lines.find((l) => l.name === "M2500 Motor");
  if (motor) {
    await prisma.purchaseRequest.create({
      data: {
        projectId: motor.projectId,
        status: "approved",
        createdById: sam.id,
        createdAt: new Date(Date.now() - 6 * 86_400_000),
        decidedById: dev.id,
        decidedAt: new Date(Date.now() - 5 * 86_400_000),
        decisionNote: "Approved within the solid demo budget.",
        items: { create: [snap(motor, 0)] },
      },
    });
  }
  console.log(`seed-local: ${devEmail} is a PVP; demo purchase requests added.`);
}

async function seedDemo() {

  const user = (email, name) => prisma.user.upsert({ where: { email }, create: { email, name }, update: {} });
  const dev = await user(devEmail, devName);
  const alex = await user("alex.kim@berkeley.edu", "Alex Kim");
  const sam = await user("sam.rivera@berkeley.edu", "Sam Rivera");
  const jordan = await user("jordan.lee@berkeley.edu", "Jordan Lee");
  await prisma.adminEmail.upsert({ where: { email: devEmail }, create: { email: devEmail }, update: {} });

  const project = (name, parentId, color, extra = {}) =>
    prisma.project.create({ data: { name, parentId, color, createdById: dev.id, ...extra } });
  const le4 = await project("LE4", null, "#6366f1", { featured: true });
  const engine = await project("LE4 Engine", le4.id, "#6366f1", { description: "Design and manufacture of the LE4 liquid engine" });
  const chamber = await project("Thrust Chamber", engine.id, "#db7624");
  await project("Machining", engine.id, "#0e94af");
  const solid = await project("LE4 Solid Demo", le4.id, "#64f2d5", { description: "Solid demonstrator for LE4" });
  const avionics = await project("LE4 Avionics", le4.id, "#f2a464", { description: "Flight avionics for LE4" });
  const fc = await project("Flight Computer", avionics.id, "#6c46b3");
  const video = await project("Live Video", avionics.id, "#fff36b");
  await project("Cap Fill Board", avionics.id, "#6366f1");
  const recovery = await project("LE4 Recovery", le4.id, "#c8327a");
  const ssep3 = await project("SSEP3", null, "#ff00d0", { featured: true, trackOrder: 1 });
  await project("SSEP3 Subscale", ssep3.id, "#0003a8");
  await project("SSEP3 Avionics", ssep3.id, "#6366f1");
  await project("Luna", null, "#f264b0", { description: "Guided parachute payload" });

  const task = (projectId, title, status, extra = {}) =>
    prisma.task.create({ data: { projectId, title, status, createdById: dev.id, ...extra } });
  const fcTask = await task(fc.id, "Lay out flight computer rev B", "in_progress", { assignees: { connect: [{ id: dev.id }] } });
  const injector = await task(chamber.id, "Machine injector plate", "todo", {
    manufacturing: { create: { partName: "Injector plate", quantity: 1, material: "6061-T6" } },
  });
  await task(solid.id, "Static fire the solid demo", "todo", { dueDate: new Date("2026-11-20") });
  await task(recovery.id, "Pack and ground-test main chute", "backlog");

  // Filings the BOM's reimbursed column reads from: one paid out, one in flight.
  const reimbursement = (subject, cents, status, callinkStatus) =>
    prisma.reimbursement.create({
      data: {
        source: "starproject",
        status,
        callinkStatus,
        subject,
        amountCents: cents,
        payeeFirstName: "Alex",
        payeeLastName: "Kim",
        payeeEmail: alex.email,
        submitterName: "Alex K.",
        submitterEmail: alex.email,
        createdById: alex.id,
      },
    });
  const paid = await reimbursement("LE4 avionics: DAQ PCBs", 32672, "submitted", "Completed");
  const pending = await reimbursement("LE4 avionics: GX12 connectors", 2241, "pending_approval", null);

  let position = 0;
  const line = (projectId, data) =>
    prisma.bomItem.create({
      data: {
        projectId,
        createdById: dev.id,
        position: ++position,
        approvedAt: data.status && data.status !== "planned" ? new Date() : null,
        ...data,
      },
    });
  const day = (s) => new Date(`${s}T00:00:00Z`);

  // LE4 Recovery: LE3's Recovery sheet, still to buy.
  await line(recovery.id, { name: 'Main Parachute (168" PDA)', unitCostCents: 153965, quantity: 1, shippingCents: 500, supplier: "Fruity Chutes", url: "https://shop.fruitychutes.com/collections/iris-ultra-compact-chutes", notes: "Ask about 725lb Microline" });
  await line(recovery.id, { name: "Drogue", unitCostCents: 31931, quantity: 1, supplier: "Fruity Chutes" });
  await line(recovery.id, { name: "Shockcord (200 ft)", unitCostCents: 140, quantity: 200, shippingCents: 500, supplier: "Mac Performance", url: "https://macperformancerocketry.com/collections/tubular-kevlar" });
  await line(recovery.id, { name: "M5 x 15mm screws", partNumber: "91290A231", unitCostCents: 1345, quantity: 1, shippingCents: 500, supplier: "McMaster", url: "https://www.mcmaster.com/91290A231/", status: "approved" });
  await line(recovery.id, { name: "E-matches (40 x 7ft)", unitCostCents: 3490, quantity: 1, shippingCents: 1944, supplier: "MJG", status: "ordered", orderedAt: day("2026-10-06"), purchaserId: sam.id });
  await line(recovery.id, { name: "Buffer", kind: "allowance", unitCostCents: 50000, notes: "Testing, small backups, tool replacements" });
  await line(recovery.id, { name: "Main Parachute (backup)", unitCostCents: 97800, quantity: 1, supplier: "Fruity Chutes", spare: true });

  // LE4 Avionics and Flight Computer: LE3's Avionics sheet, mostly bought.
  await line(avionics.id, { name: "DAQ PCBs", unitCostCents: 16753, quantity: 1, shippingCents: 15919, realizedCents: 32672, supplier: "JLCPCB", status: "received", orderedAt: day("2026-09-29"), purchaserId: alex.id, location: "Snode", reimbursementId: paid.id });
  await line(avionics.id, { name: "GX12 connectors", unitCostCents: 60, quantity: 30, shippingCents: 441, realizedCents: 2241, supplier: "Aliexpress", status: "received", orderedAt: day("2026-10-02"), purchaserId: alex.id, location: "Snode", reimbursementId: pending.id });
  await line(avionics.id, { name: "5x 100ft 22 AWG wire", unitCostCents: 16888, quantity: 1, shippingCents: 3098, realizedCents: 19986, supplier: "Remington Industries", status: "ordered", orderedAt: day("2026-10-09"), purchaserId: jordan.id });
  await line(fc.id, { name: "STM32H723ZGT6", manufacturer: "STMicroelectronics", partNumber: "497-STM32H723ZGT6-ND", unitCostCents: 1410, quantity: 3, shippingCents: 699, supplier: "Digikey", url: "https://www.digikey.com/", status: "approved", taskId: fcTask.id });
  await line(fc.id, { name: "Flight computer PCB (rev B)", unitCostCents: 4200, quantity: 5, shippingCents: 2500, supplier: "JLCPCB", taskId: fcTask.id });
  await line(video.id, { name: "Runcam Split 4", unitCostCents: 8999, quantity: 1, supplier: "Runcam" });

  // LE4 Solid Demo: LE3's Airframe sheet, some bought, one paid back before STAR tracked it.
  await line(solid.id, { name: "Fiberglass Nose Cone", unitCostCents: 18029, quantity: 1, shippingCents: 5075, realizedCents: 23104, supplier: "Wildman Rocketry", status: "received", purchaserName: "Steven", location: "Kush's house", reimbursedElsewhere: true });
  await line(solid.id, { name: "M2500 Motor", unitCostCents: 85900, quantity: 3, shippingCents: 21177, supplier: "Aerotech", status: "approved" });
  await line(solid.id, { name: "West Systems Epoxy", unitCostCents: 18599, quantity: 1, shippingCents: 1349, supplier: "West Marine" });

  // LE4 Engine: on the chamber, linked to the manufacturing task.
  await line(chamber.id, { name: "6061-T6 plate, 1/2 in", unitCostCents: 7881, quantity: 1, supplier: "Jacobs Material Store", taskId: injector.id });
  // On LE4 itself: a vehicle-wide line.
  await line(le4.id, { name: "Launch-day consumables", kind: "allowance", unitCostCents: 30000, notes: "Tape, zip ties, gloves" });

  console.log(`seed-local: LE4 with ${position} BOM lines, 4 people, 2 reimbursements. ${devEmail} is an admin.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
