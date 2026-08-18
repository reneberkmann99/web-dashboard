-- Containers belong to a Node and optionally a Project/Stack.
ALTER TABLE "Container" ADD COLUMN "projectId" TEXT;
CREATE INDEX "Container_projectId_idx" ON "Container"("projectId");
ALTER TABLE "Container" ADD CONSTRAINT "Container_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
