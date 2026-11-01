export interface TenantDTO {
  id: string;
  name: string;
  code: string;
  currency: string;
  isActive: boolean;
  createdAt: string;
}

export interface StoreDTO {
  id: string;
  tenantId: string;
  name: string;
  code: string;
  address?: string | undefined;
  phone?: string | undefined;
  isActive: boolean;
  createdAt: string;
}

export interface UserDTO {
  id: string;
  tenantId: string;
  username: string;
  fullName: string;
  role: 'OWNER' | 'STORE_MANAGER' | 'CASHIER' | 'AUDITOR';
  storeId?: string | undefined;
  isActive: boolean;
  createdAt: string;
}

export interface AuthSessionDTO {
  token: string;
  expiresAt: string;
  user: UserDTO;
  permissions: string[];
}
