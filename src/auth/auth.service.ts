import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { compare, hash } from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { Prisma, User } from '@prisma/client';
import { APP_CONFIG, AppConfiguration } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { TokenCryptoService } from '../crypto/token-crypto.service';
import { JwtPayload, TokenPair } from './auth.types';
import { LoginDto, RegisterDto } from './dto/auth.dto';

interface SessionContext {
  userAgent?: string;
  ip?: string;
}

/**
 * Autenticación de la plataforma, totalmente independiente de las cuentas de
 * Google que el usuario vincule después. Un usuario de StackDrive existe y
 * puede operar sin tener ninguna cuenta de Drive enlazada.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    @Inject(APP_CONFIG) private readonly config: AppConfiguration,
  ) {}

  async register(dto: RegisterDto, session: SessionContext): Promise<TokenPair> {
    const email = dto.email.trim().toLowerCase();
    const passwordHash = await hash(dto.password, this.config.auth.bcryptRounds);

    let user: User;
    try {
      user = await this.prisma.user.create({
        data: { email, passwordHash, displayName: dto.displayName?.trim() || null },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' // violación de unicidad
      ) {
        throw new ConflictException('Ya existe una cuenta con ese email');
      }
      throw error;
    }

    this.logger.log(`Usuario registrado: ${user.id}`);
    return this.issueTokens(user, session);
  }

  async login(dto: LoginDto, session: SessionContext): Promise<TokenPair> {
    const email = dto.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });

    // Comparamos siempre contra un hash, incluso si el usuario no existe, para
    // que el tiempo de respuesta no revele qué emails están registrados.
    const passwordHash = user?.passwordHash ?? DUMMY_HASH;
    const valid = await compare(dto.password, passwordHash);

    if (!user || !valid) {
      throw new UnauthorizedException('Credenciales incorrectas');
    }

    return this.issueTokens(user, session);
  }

  /**
   * Rota el refresh token: el entregado se revoca y se emite uno nuevo. Así,
   * si un refresh token robado se usa después del legítimo, ya no es válido.
   */
  async refresh(refreshToken: string, session: SessionContext): Promise<TokenPair> {
    const tokenHash = TokenCryptoService.hashOpaqueToken(refreshToken);
    const stored = await this.prisma.authSession.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token inválido o caducado');
    }

    await this.prisma.authSession.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    return this.issueTokens(stored.user, session);
  }

  async logout(refreshToken: string): Promise<void> {
    const tokenHash = TokenCryptoService.hashOpaqueToken(refreshToken);
    await this.prisma.authSession.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async logoutAll(userId: string): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async profile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        displayName: true,
        createdAt: true,
        _count: { select: { googleAccounts: true } },
      },
    });

    if (!user) {
      throw new UnauthorizedException('El usuario ya no existe');
    }

    const { _count, ...rest } = user;
    return { ...rest, linkedAccounts: _count.googleAccounts };
  }

  private async issueTokens(user: User, session: SessionContext): Promise<TokenPair> {
    const payload: JwtPayload = { sub: user.id, email: user.email };
    const accessToken = await this.jwtService.signAsync(payload);

    // El refresh token es opaco (no un JWT): así su revocación es inmediata y
    // no depende de que expire. En base de datos solo guardamos su hash.
    const refreshToken = randomBytes(48).toString('base64url');
    const expiresAt = new Date(
      Date.now() + this.config.auth.refreshTokenTtlDays * 24 * 60 * 60 * 1000,
    );

    await this.prisma.authSession.create({
      data: {
        userId: user.id,
        tokenHash: TokenCryptoService.hashOpaqueToken(refreshToken),
        expiresAt,
        userAgent: session.userAgent?.slice(0, 255) ?? null,
        ip: session.ip ?? null,
      },
    });

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: parseTtlSeconds(this.config.auth.accessTokenTtl),
    };
  }
}

/** Hash de una contraseña aleatoria, usado solo para igualar tiempos. */
const DUMMY_HASH = '$2b$12$C6UzMDM.H6dfI/f/IKcEe.CkQxVZNhE6eKkQ3VtOtjHhB0bcUdm.O';

/** Traduce "15m" / "1h" / "900s" a segundos, para informar al cliente. */
function parseTtlSeconds(ttl: string): number {
  const match = /^(\d+)([smhd])?$/.exec(ttl.trim());
  if (!match) return 900;
  const value = Number(match[1]);
  const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return value * (multipliers[match[2] ?? 's'] ?? 1);
}
