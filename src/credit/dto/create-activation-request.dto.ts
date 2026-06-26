import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator'

export class CreateActivationRequestDto {
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  fullName: string

  @IsEmail()
  @MaxLength(160)
  email: string

  @IsString()
  @Matches(/^\+?[0-9]{7,20}$/, { message: 'phone debe contener entre 7 y 20 dígitos' })
  phone: string
}
