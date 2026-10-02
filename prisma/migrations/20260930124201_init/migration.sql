-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED');

-- CreateEnum
CREATE TYPE "SuppressionReason" AS ENUM ('STOP', 'UNSUBSCRIBE', 'MANUAL', 'COMPLAINT', 'INVALID');

-- CreateTable
CREATE TABLE "Integration" (
    "id" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "ghlAccessToken" TEXT NOT NULL,
    "ghlRefreshToken" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3),
    "conversationProviderId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'sendblue',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "conversationId" TEXT,
    "direction" "MessageDirection" NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'imessage',
    "body" TEXT NOT NULL,
    "mediaUrl" TEXT,
    "providerMessageId" TEXT,
    "ghlMessageId" TEXT,
    "campaignId" TEXT,
    "campaignStep" INTEGER,
    "idempotencyKey" TEXT,
    "status" "MessageStatus" NOT NULL DEFAULT 'QUEUED',
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Suppression" (
    "id" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "contactId" TEXT,
    "phone" TEXT NOT NULL,
    "reason" "SuppressionReason" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Suppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sender" (
    "id" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "senderNumber" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "dailyLimit" INTEGER,
    "hourlyLimit" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sender_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Integration_locationId_key" ON "Integration"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_idempotencyKey_key" ON "Message"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Message_providerMessageId_idx" ON "Message"("providerMessageId");

-- CreateIndex
CREATE INDEX "Message_ghlMessageId_idx" ON "Message"("ghlMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "Suppression_locationId_phone_key" ON "Suppression"("locationId", "phone");
