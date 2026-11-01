export abstract class Entity<T> {
  protected readonly _id: string;
  protected readonly props: T;
  protected readonly _createdAt: Date;
  protected _updatedAt: Date;

  constructor(id: string, props: T, createdAt?: Date, updatedAt?: Date) {
    this._id = id;
    this.props = props;
    this._createdAt = createdAt ?? new Date();
    this._updatedAt = updatedAt ?? new Date();
  }

  public get id(): string {
    return this._id;
  }

  public get createdAt(): Date {
    return this._createdAt;
  }

  public get updatedAt(): Date {
    return this._updatedAt;
  }

  public equals(object?: Entity<T>): boolean {
    if (object === null || object === undefined) {
      return false;
    }
    if (this === object) {
      return true;
    }
    if (!(object instanceof Entity)) {
      return false;
    }
    return this._id === object._id;
  }
}
