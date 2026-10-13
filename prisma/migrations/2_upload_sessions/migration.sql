-- CreateTable
CREATE TABLE "upload_sessions" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "sessionUrl" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "parentId" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "upload_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "upload_sessions_accountId_idx" ON "upload_sessions"("accountId");

-- CreateIndex
CREATE INDEX "upload_sessions_expiresAt_idx" ON "upload_sessions"("expiresAt");

-- AddForeignKey
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "google_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
