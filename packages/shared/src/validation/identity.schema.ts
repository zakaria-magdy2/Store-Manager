import { z } from 'zod';

export const LoginSchema = z.object({
  tenantCode: z.string().min(1, 'Tenant code is required').trim(),
  username: z.string().min(1, 'Username is required').trim(),
  password: z.string().min(1, 'Password is required'),
});

export type LoginInput = z.infer<typeof LoginSchema>;

export const CreateTenantSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').trim(),
  code: z
    .string()
    .min(2, 'Code must be at least 2 characters')
    .max(20, 'Code maximum 20 characters')
    .regex(/^[A-Za-z0-9_-]+$/, 'Code can only contain letters, numbers, hyphens, and underscores')
    .trim(),
  currency: z.string().length(3, 'Currency must be a 3-letter ISO code').trim(),
});

export type CreateTenantInput = z.infer<typeof CreateTenantSchema>;

export const CreateStoreSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').trim(),
  code: z
    .string()
    .min(2, 'Code must be at least 2 characters')
    .max(20)
    .regex(/^[A-Za-z0-9_-]+$/)
    .trim(),
  address: z.string().optional(),
  phone: z.string().optional(),
});

export type CreateStoreInput = z.infer<typeof CreateStoreSchema>;

export const CreateUserSchema = z
  .object({
    username: z
      .string()
      .min(3, 'Username must be at least 3 characters')
      .max(30)
      .regex(/^[a-z0-9_]+$/, 'Username must be lowercase letters, numbers, and underscores only')
      .trim(),
    password: z.string().min(12, 'Password must be at least 12 characters').max(128),
    fullName: z.string().min(2, 'Full name must be at least 2 characters').trim(),
    phone: z.string().trim().max(32).regex(/^[+0-9().\-\s]*$/).optional(),
    employmentStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
      const date = new Date(`${value}T00:00:00.000Z`);
      return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
    }).optional(),
    role: z.enum(['OWNER', 'STORE_MANAGER', 'CASHIER', 'AUDITOR']),
    storeId: z.string().uuid().optional(),
  })
  .refine(
    (data) => {
      if (data.role === 'CASHIER' && !data.storeId) {
        return false;
      }
      return true;
    },
    {
      message: 'Cashiers must be assigned to a specific store',
      path: ['storeId'],
    },
  );

export type CreateUserInput = z.infer<typeof CreateUserSchema>;
