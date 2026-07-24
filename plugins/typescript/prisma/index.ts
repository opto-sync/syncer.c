import { Prisma } from '@prisma/client/extension';
import { BaseMergeStrategy } from '../../../bindings/typescript/BaseMergeStrategy';
import { mergeJson } from '../../../bindings/typescript';

/**
 * Creates a Prisma Client Extension that automatically merges JSONB fields 
 * on conflicts or manual sync endpoints, using the opto-sync C library.
 */
export function withSyncer(modelName: string, fieldName: string, strategy: BaseMergeStrategy<any>) {
  return Prisma.defineExtension({
    name: 'opto-sync-syncer',
    model: {
      $allModels: {
        /**
         * Custom method added to Prisma models.
         * Usage: prisma.user.syncJsonField({ id: 1 }, rawIncomingJson)
         */
        async syncJsonField(this: any, where: any, incomingRawJson: string) {
          const context = Prisma.getExtensionContext(this);
          
          // 1. Fetch current raw JSON from DB 
          // Note: In a real implementation we'd use raw queries to prevent 
          // Prisma from deserializing the JSONB column to a JS object, to hit our Zero-Deserialization goal.
          const record = await (context as any).findUnique({ where });
          const currentRawJson = JSON.stringify(record[fieldName]); // fallback if Prisma deserialized it
          
          // 2. Perform native C merge
          const mergedRaw = mergeJson(currentRawJson, incomingRawJson, strategy.handleConflict.bind(strategy));
          
          // 3. Save back to DB
          return (context as any).update({
            where,
            data: {
              [fieldName]: JSON.parse(mergedRaw) // Prisma requires object here unless raw query
            }
          });
        }
      }
    }
  });
}
