import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function migrateContacts() {
  console.log('Starting contact migration from MessageLog...');

  const businesses = await prisma.business.findMany({
    select: { id: true, name: true }
  });

  console.log(`Found ${businesses.length} businesses to process`);

  let totalCreated = 0;
  let totalSkipped = 0;

  for (const business of businesses) {
    console.log(`\nProcessing business: ${business.name} (${business.id})`);

    const messages = await prisma.messageLog.findMany({
      where: {
        businessId: business.id,
        direction: 'inbound'
      },
      select: {
        sender: true,
        createdAt: true,
        metadata: true
      },
      orderBy: { createdAt: 'asc' }
    });

    const contactMap = new Map<string, {
      phone: string;
      name: string | null;
      firstMessageAt: Date;
      lastMessageAt: Date;
      messageCount: number;
    }>();

    for (const msg of messages) {
      const phone = msg.sender;
      const metadata = msg.metadata as any;
      const pushName = metadata?.pushName || null;

      const existing = contactMap.get(phone);
      if (existing) {
        existing.lastMessageAt = msg.createdAt;
        existing.messageCount++;
        if (!existing.name && pushName) {
          existing.name = pushName;
        }
      } else {
        contactMap.set(phone, {
          phone,
          name: pushName,
          firstMessageAt: msg.createdAt,
          lastMessageAt: msg.createdAt,
          messageCount: 1
        });
      }
    }

    console.log(`  Found ${contactMap.size} unique contacts from messages`);

    let created = 0;
    let skipped = 0;

    for (const [phone, data] of contactMap) {
      try {
        const existing = await prisma.contact.findUnique({
          where: { businessId_phone: { businessId: business.id, phone } }
        });

        if (existing) {
          skipped++;
          continue;
        }

        await prisma.contact.create({
          data: {
            businessId: business.id,
            phone: data.phone,
            name: data.name,
            source: 'MIGRATED',
            firstMessageAt: data.firstMessageAt,
            lastMessageAt: data.lastMessageAt,
            messageCount: data.messageCount
          }
        });
        created++;
      } catch (err: any) {
        console.error(`  Error creating contact ${phone}:`, err.message);
      }
    }

    console.log(`  Created: ${created}, Skipped (already exist): ${skipped}`);
    totalCreated += created;
    totalSkipped += skipped;
  }

  console.log(`\n=== Migration Complete ===`);
  console.log(`Total contacts created: ${totalCreated}`);
  console.log(`Total contacts skipped: ${totalSkipped}`);

  await prisma.$disconnect();
}

migrateContacts().catch(console.error);
