-- DropIndex
DROP INDEX "Message_ghlMessageId_idx";

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "dispatchedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "Message_ghlMessageId_key" ON "Message"("ghlMessageId");

