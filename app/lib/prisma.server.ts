import db from "../db.server";

/**
 * Back-compat Prisma export.
 * Some routes import { prisma } from "../lib/prisma.server".
 * The canonical Prisma client is the default export from app/db.server.ts.
 */
export const prisma = db;
export default prisma;
