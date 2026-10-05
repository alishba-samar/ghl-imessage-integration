-- AlterTable
ALTER TABLE "Integration" ADD COLUMN     "companyId" TEXT;

-- CreateTable
CREATE TABLE "AgencyIntegration" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "ghlAccessToken" TEXT NOT NULL,
    "ghlRefreshToken" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgencyIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgencyIntegration_companyId_key" ON "AgencyIntegration"("companyId");
