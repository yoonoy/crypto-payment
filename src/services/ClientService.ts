import { AppError } from '../errors';
import { ClientStore } from '../domain/ports';
import { Client } from '../domain/types';

export class ClientService {
  constructor(private readonly clients: ClientStore) {}

  create(email: string, name: string): Promise<Client> {
    return this.clients.create(email, name);
  }

  async get(id: string): Promise<Client> {
    const c = await this.clients.findById(id);
    if (!c) throw new AppError(404, 'CLIENT_NOT_FOUND', 'client not found');
    return c;
  }

  list(): Promise<Client[]> {
    return this.clients.list();
  }
}
