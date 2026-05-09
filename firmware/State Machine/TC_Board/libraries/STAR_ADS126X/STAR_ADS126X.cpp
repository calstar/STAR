#include "my_ADS126X.h"
#include <SPI.h>
#include <Arduino.h>

/*!< Initial ADC Setup */ 

ADS126X::ADS126X() {
}

void ADS126X::begin(uint8_t chip_select) {
  cs_used = true;
  cs_pin = chip_select;
  pinMode(cs_pin, OUTPUT);
  digitalWrite(cs_pin, HIGH);

  SPI.begin();
  
  ADS126X::reset();
  ADS126X::readAllRegisters();
}

/*!< Regular ADC Commands    */

void ADS126X::noOperation() {
  ADS126X::sendCommand(ADS126X_NOP);
}

void ADS126X::reset() {
  sendCommand(ADS126X_RESET); // send reset command
}

void ADS126X::startADC1() {
    ADS126X::sendCommand(ADS126X_START1);
}

void ADS126X::stopADC1() {
  ADS126X::sendCommand(ADS126X_STOP1);
}

void ADS126X::startADC2() {
    ADS126X::sendCommand(ADS126X_START2);
}

void ADS126X::stopADC2() {
  ADS126X::sendCommand(ADS126X_STOP2);
}

// int32_t ADS126X::readADC1(uint8_t pos_pin, uint8_t neg_pin) {
//   digitalWrite(cs_pin, LOW);

//   // create buffer to hold transmission
//   uint8_t buff[10] = {0}; // plenty of room, all zeros

//   union { // create a structure to hold all the data
//     struct {
//       uint32_t DATA4:8; // bits 0.. 7
//       uint32_t DATA3:8; // bits 8.. 15
//       uint32_t DATA2:8; // bits 16.. 23
//       uint32_t DATA1:8; // bits 24.. 31
//     } bit;
//     uint32_t reg;
//   } ADC_BYTES;
//   ADC_BYTES.reg = 0; // clear the ram just in case

//   // Only write to multiplex register if desired pins are different 
//   if((REGISTER.INPMUX.bit.MUXN != neg_pin) || (REGISTER.INPMUX.bit.MUXP != pos_pin)) {
//     REGISTER.INPMUX.bit.MUXN = neg_pin;
//     REGISTER.INPMUX.bit.MUXP = pos_pin;
//     ADS126X::writeRegister(ADS126X_INPMUX); 
//   }

//   uint8_t i = 0; // current place in outgoing buffer
//   buff[i] = ADS126X_RDATA1; // the read adc1 command
//   i++;

//   if(REGISTER.INTERFACE.bit.STATUS) i++; // place to hold status byte
//   i += 4; // place to hold adc data
//   if(REGISTER.INTERFACE.bit.CRC>0) i++; // place to hold checksum/crc byte

//   _ads126x_spi_rw(buff,i); // write spi, save values on buff

//   uint8_t j = 1; // start at byte 1, either status or first adc value

//   if(REGISTER.INTERFACE.bit.STATUS) { // if status is being read
//     STATUS.reg = buff[j]; // save status byte
//     j++; // increment position counter
//   }

//    // save the data bytes
//    ADC_BYTES.bit.DATA1 = buff[j]; j++;
//    ADC_BYTES.bit.DATA2 = buff[j]; j++;
//    ADC_BYTES.bit.DATA3 = buff[j]; j++;
//    ADC_BYTES.bit.DATA4 = buff[j]; j++;

// //   if(REGISTER.INTERFACE.bit.CRC==ADS126X_CHECKSUM) {
// //     uint8_t checkbyte = buff[j];

// //     // if(ADS126X::find_checksum(ADC_BYTES.reg,checkbyte)){
// //     // }
// //    }
// //    else if(REGISTER.INTERFACE.bit.CRC==ADS126X_CHECK_CRC) {
// //     uint8_t checkbyte = buff[j];
// //     CHECKSUM = ADS126X::find_crc(ADC_BYTES.reg,checkbyte);
// //   }

//   digitalWrite(cs_pin, HIGH);
//   return ADC_BYTES.reg;
// }

void ADS126X::setInputMux(uint8_t pos_pin, uint8_t neg_pin){
  if((REGISTER.INPMUX.bit.MUXN != neg_pin) || (REGISTER.INPMUX.bit.MUXP != pos_pin)) {
    REGISTER.INPMUX.bit.MUXN = neg_pin;
    REGISTER.INPMUX.bit.MUXP = pos_pin;
    ADS126X::writeRegister(ADS126X_INPMUX); 
  }
}

void ADS126X::setADC2Mux(uint8_t pos_pin, uint8_t neg_pin){
  if((REGISTER.ADC2MUX.bit.MUXN != neg_pin) || (REGISTER.ADC2MUX.bit.MUXP != pos_pin)) {
    REGISTER.ADC2MUX.bit.MUXN = neg_pin;
    REGISTER.ADC2MUX.bit.MUXP = pos_pin;
    ADS126X::writeRegister(ADS126X_ADC2MUX); 
  }
}

ADS126X::ADCReading ADS126X::readADC1(){
  digitalWrite(cs_pin, LOW);

  // Create buffer to hold transmission
  uint8_t buff[10] = {0};

  // Union to hold ADC data
  union { // create a structure to hold all the data
    struct {
      uint32_t DATA4:8; // bits 0.. 7
      uint32_t DATA3:8; // bits 8.. 15
      uint32_t DATA2:8; // bits 16.. 23
      uint32_t DATA1:8; // bits 24.. 31
    } bit;
    uint32_t reg;
  } ADC_BYTES;
  ADC_BYTES.reg = 0; // clear the ram just in case

  uint8_t i = 0;
  buff[i++] = ADS126X_RDATA1;

  if(REGISTER.INTERFACE.bit.STATUS) i++; // Space for status byte
  i += 4; // Space for ADC data (4 bytes)
  if(REGISTER.INTERFACE.bit.CRC > 0) i++; 

  ADS126X::spi_rw(buff, i);

  uint8_t j = 1;

  if(REGISTER.INTERFACE.bit.STATUS) {
    STATUS.reg = buff[j++]; // Save status byte
  }

  ADC_BYTES.bit.DATA1 = buff[j++];
  ADC_BYTES.bit.DATA2 = buff[j++];
  ADC_BYTES.bit.DATA3 = buff[j++];
  ADC_BYTES.bit.DATA4 = buff[j++];

  digitalWrite(cs_pin, HIGH);

  bool checksumValid = true;
  if(REGISTER.INTERFACE.bit.CRC==ADS126X_CHECKSUM) {
    uint8_t checkbyte = buff[j];
    checksumValid = ADS126X::check_checksum(ADC_BYTES.reg,checkbyte);
   }
   else if(REGISTER.INTERFACE.bit.CRC==ADS126X_CHECK_CRC) {
    uint8_t checkbyte = buff[j];
    checksumValid = ADS126X::check_crc(ADC_BYTES.reg,checkbyte);
  }
  CHECKSUM = checksumValid;

  ADS126X::ADCReading result;
  result.value = static_cast<int32_t>(ADC_BYTES.reg);
  result.checksumValid = checksumValid;
  return result;
}

ADS126X::ADCReading ADS126X::readADC1(uint8_t pos_pin, uint8_t neg_pin) {
  ADS126X::setInputMux(pos_pin, neg_pin);
  return ADS126X::readADC1();
}

ADS126X::ADCReading ADS126X::readADC2() {
  digitalWrite(cs_pin, LOW);;

  // create buffer to hold transmission
  uint8_t buff[10] = {0}; // plenty of room, all zeros

  union { // create a structure to hold all the data
    struct {
      uint32_t DATA3:8; // bits 0.. 7
      uint32_t DATA2:8; // bits 8.. 15
      uint32_t DATA1:8; // bits 16.. 23
      uint32_t :8;      // bits 24.. 31
    } bit;
    uint32_t reg;
  } ADC_BYTES;
  ADC_BYTES.reg = 0; // clear so pad byte is 0

  uint8_t i = 0; // current place in outgoing buffer
  buff[i] = ADS126X_RDATA2; // the read adc2 command
  i++;

  if(REGISTER.INTERFACE.bit.STATUS) i++; // place to hold status byte
  i += 3; // place to hold adc data
  i++; // place to hold pad byte
  if(REGISTER.INTERFACE.bit.CRC>0) i++; // place to hold checksum/crc byte

  ADS126X::spi_rw(buff,i); // write spi, save values on buff

  uint8_t j = 1; // start at byte 1, either status or first adc value

  if(REGISTER.INTERFACE.bit.STATUS) { // if status is being read
    STATUS.reg = buff[j]; // save status byte
    j++; // increment position counter
  }

   // save the data bytes
   ADC_BYTES.bit.DATA1 = buff[j]; j++;
   ADC_BYTES.bit.DATA2 = buff[j]; j++;
   ADC_BYTES.bit.DATA3 = buff[j]; j++;
   j++; // skip pad byte

  bool checksumValid = true;
  if(REGISTER.INTERFACE.bit.CRC==ADS126X_CHECKSUM) {
    uint8_t checkbyte = buff[j];
    checksumValid = ADS126X::check_checksum(ADC_BYTES.reg,checkbyte);
   }
   else if(REGISTER.INTERFACE.bit.CRC==ADS126X_CHECK_CRC) {
    uint8_t checkbyte = buff[j];
    checksumValid = ADS126X::check_crc(ADC_BYTES.reg,checkbyte);
  }
  CHECKSUM = checksumValid;

  digitalWrite(cs_pin, HIGH);

  ADS126X::ADCReading result;
  result.value = static_cast<int32_t>(ADC_BYTES.reg);
  result.checksumValid = checksumValid;
  return result;
}

ADS126X::ADCReading ADS126X::readADC2(uint8_t pos_pin, uint8_t neg_pin) {
  ADS126X::setADC2Mux(pos_pin, neg_pin);
  return ADS126X::readADC2();
}


/*!< SPI Communication Commands */
void ADS126X::sendCommand(uint8_t command) {
  digitalWrite(cs_pin, LOW);

  uint8_t buff[1] = {command};
  ADS126X::spi_rw(buff,1);

  digitalWrite(cs_pin, HIGH);
}

// See datasheet page 87
// Reads specified number of registers, starting at start_reg and adding one to the address each time 
void ADS126X::writeRegisters(uint8_t start_reg, uint8_t num) {
  digitalWrite(cs_pin, LOW);
  
  uint8_t buff[50] = {0}; // plenty of room, all zeros

  start_reg = start_reg & 0x1F;
    
  buff[0] = start_reg | ADS126X_WREG; // See page 85
  buff[1] = num-1; // How many registers we are going to write to, see datasheet 

  // Put the desired register data in buffer
  for(uint8_t i = 0; i < num; i++) {
    buff[i+2] = REGISTER_ARRAY[i+start_reg];
  }

  // Have the microcontroller send the amounts, plus the commands
  ADS126X::spi_rw(buff, num + 2);

  digitalWrite(cs_pin, HIGH);
}

// See datasheet page 86
// Reads specified number of registers, starting at start_reg and adding one to the address each time 
// Saves the values into the REGISTER_ARRAY which can be read using read_register
void ADS126X::readRegisters(uint8_t start_reg, uint8_t num) {
  digitalWrite(cs_pin, LOW);

  uint8_t buff[50] = {0}; // plenty of room, all zeros

  start_reg = start_reg & 0x1F;

  buff[0] = start_reg | ADS126X_RREG; // first byte is starting register with read command
  buff[1] = num-1; // tell how many registers to read, see datasheet

  ADS126X::spi_rw(buff, num + 2); // have the microcontroller read the amounts, plus send the commands

  // save the commands to the register
  for(uint8_t i = 0; i < num; i++) {
    REGISTER_ARRAY[i+start_reg] = buff[i+2];
  }

  digitalWrite(cs_pin, HIGH);
}


// Writes to a single register
void ADS126X::writeRegister(uint8_t reg) {
  ADS126X::writeRegisters(reg, 1);
}

// Read all of the registers, their results are stored
void ADS126X::readAllRegisters() {
  ADS126X::readRegisters(0,ADS126X_REG_NUM); // read all the registers
}

// Reads from a single register and returns the value 
uint8_t ADS126X::readRegister(uint8_t reg) {
  ADS126X::readRegisters(reg, 1);
  return REGISTER_ARRAY[reg];
}

/*!< SPI Communication Commands */

// Takes in the value returned by the ADC and the checksum byte, return true if no corruption
bool ADS126X::check_checksum(uint32_t val, uint8_t checksum) {
  uint8_t sum = 0;
  uint8_t mask = -1; // 8 bit mask of all 1s
  while(val) {
    sum += val & mask; // Add the lowest byte 
    val >>= 8; // Shift to do the next byte 
  }
  sum += ADS126X_CHECK_BYTE;
  
  // Allow ±1 error tolerance for noisy SPI environments
  // Calculate arithmetic difference (wraps around for uint8_t)
  uint8_t diff = sum - checksum; // If checksum > sum, this wraps to 255, 254, etc.
  return (diff == 0 || diff == 1 || diff == 255); // Accept exact match or ±1
}

// Takes in the value returned by the ADC and the CRC byte, return true if no corruption
bool ADS126X::check_crc(uint32_t val, uint8_t CRC) {
  uint64_t num = val; // put val into a 64 bit number
  num <<= 8; // shift by 8
  uint8_t fin = -1; // 8 bit mask of all 1s

  while( (num & fin) ^ num ) { // while num is greater than 8 bits
    uint8_t msb_pos = ADS126X::msb_pos(num); // find the position of the greatest bit
    uint64_t divisor = ADS126X_CRC_BYTE; // set the divisor to 64 bit
    divisor <<= (msb_pos-9); // shift divisor to match greatest bit
    num ^= divisor; // XOR it
  }
  return ((num ^ CRC) == 0);
}

// Returns position of the most significant bit 
// An input of 0 will return 0
// Used for CRC
uint8_t ADS126X::msb_pos(uint64_t val) {
  uint8_t pos = 1;
  while(val >>= 1) pos++;
  return pos;
}


/*!< MODE0 register       */

void ADS126X::setContinuousMode() {
  REGISTER.MODE0.bit.RUNMODE = ADS126X_CONV_CONT;
  ADS126X::writeRegister(ADS126X_MODE0);
}

void ADS126X::setPulseMode() {
  REGISTER.MODE0.bit.RUNMODE = ADS126X_CONV_PULSE;
  ADS126X::writeRegister(ADS126X_MODE0);
}

void ADS126X::setChopMode(uint8_t mode) {
  REGISTER.MODE0.bit.CHOP = mode;
  ADS126X::writeRegister(ADS126X_MODE0);
}

void ADS126X::setDelay(uint8_t del) {
  REGISTER.MODE0.bit.DELAY = del;
  ADS126X::writeRegister(ADS126X_MODE0);
}



/*!< MODE1 register       */

void ADS126X::setFilter(uint8_t filter) {
  REGISTER.MODE1.bit.FILTER = filter;
  ADS126X::writeRegister(ADS126X_MODE1);
}

void ADS126X::setBiasADC(uint8_t adc_choice) {
  REGISTER.MODE1.bit.SBADC = adc_choice;
  ADS126X::writeRegister(ADS126X_MODE1);
}

void ADS126X::setBiasPolarity(uint8_t polarity) {
  REGISTER.MODE1.bit.SBPOL = polarity;
  ADS126X::writeRegister(ADS126X_MODE1);
}

void ADS126X::setBiasMagnitude(uint8_t mag) {
  REGISTER.MODE1.bit.SBMAG = mag;
  ADS126X::writeRegister(ADS126X_MODE1);
}



/*!< MODE2 register       */

void ADS126X::enablePGA() {
  REGISTER.MODE2.bit.BYPASS = ADS126X_PGA_ENABLE;
  ADS126X::writeRegister(ADS126X_MODE2);
}

void ADS126X::bypassPGA() {
  REGISTER.MODE2.bit.BYPASS = ADS126X_PGA_BYPASS;
  ADS126X::writeRegister(ADS126X_MODE2);
}

void ADS126X::setGain(uint8_t gain) {
  REGISTER.MODE2.bit.GAIN = gain;
  ADS126X::writeRegister(ADS126X_MODE2);
}

void ADS126X::setRate(uint8_t rate) {
  REGISTER.MODE2.bit.DR = rate;
  ADS126X::writeRegister(ADS126X_MODE2);
}

void ADS126X::setReference(uint8_t negativeReference, uint8_t positiveReference)
{
    REGISTER.REFMUX.bit.RMUXN = negativeReference;
    REGISTER.REFMUX.bit.RMUXP = positiveReference;
    ADS126X::writeRegister(ADS126X_REFMUX);
}




/*!< TDAC Registers       */

// TDACP (positive TDAC) 
void ADS126X::setOutputTDACP(bool enable) {
  // enable TDACP output connected to AIN6
  REGISTER.TDACP.bit.OUTP = enable ? 1 : 0;
  ADS126X::writeRegister(ADS126X_TDACP);
}
/*
void ADS126X::setReservedTDACP() {
  // clear reserved bits (bit5..6) to be safe
  // can't access unnamed bitfields directly, so operate on the full reg
  REGISTER.TDACP.reg &= ~( (1u << 5) | (1u << 6) );
  ADS126X::writeRegister(ADS126X_TDACP);
}
*/

void ADS126X::setOutputmagnitudeTDACP(uint8_t mag) {
  // default magnitude = mid-scale (0x10). MAGP is 5 bits (0..31).
  REGISTER.TDACP.bit.MAGP = mag & 0x1F; 
  ADS126X::writeRegister(ADS126X_TDACP);

}

// TDACN (negative TDAC)
void ADS126X::setOutputTDACN(bool enable) {
  // enable TDACN output connected to AIN7
  REGISTER.TDACN.bit.OUTN = enable ? 1 : 0;
  ADS126X::writeRegister(ADS126X_TDACN);
}
/*
void ADS126X::setReservedTDACN() {
  // clear reserved bits (bit5..6) to be safe
  REGISTER.TDACN.reg &= ~( (1u << 5) | (1u << 6) );
  ADS126X::writeRegister(ADS126X_TDACN);
}
*/

void ADS126X::setOutputmagnitudeTDACN(uint8_t mag) {
  // default magnitude = mid-scale (0x10). MAGN is 5 bits (0..31).
  REGISTER.TDACN.bit.MAGN = mag & 0x1F; 
  ADS126X::writeRegister(ADS126X_TDACN);
}

/*!< IDAC functionality     */

void ADS126X::setIDAC1Pin(uint8_t pin) {
  #ifndef __AVR__
  REGISTER.IDACMUX.bit.MUX1 = pin;
  #else
  REGISTER.IDACMUX.bit.ADS_MUX1 = pin;
  #endif
  ADS126X::writeRegister(ADS126X_IDACMUX);
}
void ADS126X::setIDAC2Pin(uint8_t pin) {

  #ifndef __AVR__
  REGISTER.IDACMUX.bit.MUX2 = pin;
  #else
  REGISTER.IDACMUX.bit.ADS_MUX2 = pin;
  #endif

  ADS126X::writeRegister(ADS126X_IDACMUX);
}
void ADS126X::setIDAC1Mag(uint8_t magnitude) {
  REGISTER.IDACMAG.bit.MAG1 = magnitude;
  ADS126X::writeRegister(ADS126X_IDACMAG);
}
void ADS126X::setIDAC2Mag(uint8_t magnitude) {
  REGISTER.IDACMAG.bit.MAG2 = magnitude;
  ADS126X::writeRegister(ADS126X_IDACMAG);
}

// write buffer to spi, save results over the buffer
void ADS126X::spi_rw(uint8_t buff[],uint8_t len) {
  SPI.beginTransaction( SPISettings(2000000, MSBFIRST, SPI_MODE1) ); // 2 MHz
  
  for(uint8_t i=0;i<len;i++) {
    buff[i] = SPI.transfer(buff[i]);
  }
  
  SPI.endTransaction();
}
