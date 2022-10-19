# ESP8266_Espruino_FS

Simple FS for flash

// First, we need import flash and flashFS modules
// Use require("Flash").getFree() for choose free space for file system

let flash = require("Flash");
let fs = new FlashFS(flash, 1048576, 2097152); // 2 МБ

// Lets start with formating (erase flash space) or call prepare for create only FS header

fs.format()
  or
fs.prepare()

// Open file for writing or reading, if file already created
var f = fs.openFile("somefile.txt", "w")
f.write("Bla bla bla");
f.write(0x10);
f.write(0x13);
f.write(0x10);
f.write([20, 21, 22, 23]);
f.close();

// function list show all file descriptors when created in file system
fs.list()

[
  { bof: 1048579,
    path: "somefile.txt",
    length: 15,
    addr: 1052672,
    eof: 1048604 }
 ]
 
 
Structure 

Example data                                        Size  Offset  Description

56 46 53                                            3     0    FS Header, ASCII 'VFS'
FA                                                  1     3    Start of each file (BOF)
48 65 6C 6C 6F 57 6F 72 6C 64 2E 70 6E 67 00 00    16     4    FilePath has 16 bytes  'HelloWorld.png'
00 00 00 0A                                         4    20    Filesize for content 'HelloWorld 12345', 16 bytes
00 77 88 99                                         4    24    FileAddr from flash
FB                                                  1    28    End of each file (EOF)

FS header and indexes used first flash page and used 4096 bytes. FS contains maximum 163 files. Content is being writed with second page and more.
Content of file writing in start of page. Note: file 4000 bytes has reserving 4096 bytes of page. File 4100 bytes has reserving 8192 bytes.
