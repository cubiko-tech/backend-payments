import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator'

export class CreateActivationRequestDto {
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  fullName: string

  @IsEmail()
  @MaxLength(160)
  email: string

  // Acepta el formato como lo escribe el usuario (espacios, guiones, paréntesis
  // y un '+' inicial); el service lo normaliza a solo dígitos. El lookahead
  // exige entre 7 y 15 dígitos reales (E.164 admite hasta 15).
  @IsString()
  @Matches(/^(?=(?:\D*\d){7,15}\D*$)\+?[\d\s().-]{6,24}$/, {
    message: 'phone debe tener entre 7 y 15 dígitos',
  })
  phone: string
}
