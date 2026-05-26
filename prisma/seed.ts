import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Constantes des types de collection supportés.
// Source de vérité : ajouter une entrée ici puis relancer `prisma db seed`.
const COLLECTION_TYPES: Array<{ code: string; label: string }> = [
  { code: 'vinyl', label: 'Vinyle' },
  { code: 'manga', label: 'Manga' },
  { code: 'movie', label: 'Film' },
  { code: 'book', label: 'Livre' },
  { code: 'game', label: 'Jeu vidéo' },
];

async function main() {
  for (const t of COLLECTION_TYPES) {
    await prisma.collectionType.upsert({
      where: { code: t.code },
      update: { label: t.label },
      create: t,
    });
  }
  console.log(`Seeded ${COLLECTION_TYPES.length} collection_types.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });