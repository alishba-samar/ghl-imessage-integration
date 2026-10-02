-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "phone" TEXT;

-- CreateIndex
CREATE INDEX "Message_phone_direction_createdAt_idx" ON "Message"("phone", "direction", "createdAt");
