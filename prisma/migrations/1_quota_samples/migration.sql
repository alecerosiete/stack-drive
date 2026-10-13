-- CreateTable
CREATE TABLE "quota_samples" (
    "id" BIGSERIAL NOT NULL,
    "accountId" UUID NOT NULL,
    "limitBytes" BIGINT,
    "usageBytes" BIGINT NOT NULL,
    "usageInDriveBytes" BIGINT NOT NULL,
    "usageInTrashBytes" BIGINT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quota_samples_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quota_samples_accountId_capturedAt_idx" ON "quota_samples"("accountId", "capturedAt");

-- AddForeignKey
ALTER TABLE "quota_samples" ADD CONSTRAINT "quota_samples_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "google_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
