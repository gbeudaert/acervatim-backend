import { RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json } from 'express';
import { writeFileSync } from 'fs';
import helmet from 'helmet';
import { patchNestJsSwagger, ZodValidationPipe } from 'nestjs-zod';
import { AppModule } from './app.module';
import { ProblemDetailsExceptionFilter } from './common/filters/problem-details.filter';
import { CorrelationIdInterceptor } from './common/interceptors/correlation-id.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(json({ limit: '256kb' }));

  app.setGlobalPrefix('v1', {
    exclude: [
      { path: 'health', method: RequestMethod.ALL },
      { path: 'health/(.*)', method: RequestMethod.ALL },
    ],
  });

  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalInterceptors(new CorrelationIdInterceptor());
  app.useGlobalFilters(new ProblemDetailsExceptionFilter());

  patchNestJsSwagger();
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Acervatim API')
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  writeFileSync('./openapi.json', JSON.stringify(document, null, 2));
  if (process.env.NODE_ENV !== 'production') {
    SwaggerModule.setup('docs', app, document);
  }

  const config = app.get(ConfigService);
  const port = config.get<number>('PORT', 3000);

  await app.listen(port);
}

bootstrap();
