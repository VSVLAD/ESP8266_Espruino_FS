
let params = {
    PAGE_SIZE: 4096,

    FILE_NAME_LENGTH: 16,
    FILE_SIZE_LENGTH: 4,
    FILE_ADDR_LENGTH: 4,
    BOF_LENGTH: 1,
    EOF_LENGTH: 1,

    HEADER_BYTE: [56, 46, 53],
    BOF_BYTE: 250,
    EOF_BYTE: 251,

    flash: undefined,
    flash_addr: undefined,
    flash_length: undefined
};

// Конструктор класса для файловой системы
function FlashFS(flashObject, start_addr, length){
    params.flash = flashObject;
    params.flash_addr = start_addr;
    params.flash_length = length;
}

// Метод помощник: Перевести массив байт в число UInt32
FlashFS.prototype.b4u32 = function(arr){
    return (arr[3]) | (arr[2] << 8) | (arr[1] << 16) | (arr[0] << 24);
};

// Метод помощник: Перевести число из UInt32 в массив байт
FlashFS.prototype.u32b4 = function(number){
    return [(number >> 24) & 0xFF, (number >> 16) & 0xFF, (number >> 8)  & 0xFF, (number >> 0)  & 0xFF];
};

// Проверка, что флеш память инициализирована модулем FS и нет ошибок
FlashFS.prototype.check = function(){
    if (params.flash.read(3, params.flash_addr) != params.HEADER_BYTE){
        return false;
    }

    return true;
};

// Инициализация FS
FlashFS.prototype.prepare = function(){
    params.flash.write(params.HEADER_BYTE, params.flash_addr);
    return this.check();
};


// Полное форматирование FS с обнулением всех страниц флеша
FlashFS.prototype.format = function(){

    // Watchdog нужно усмирить и перейти на асинхронный режим
    for (let cAddr = params.flash_addr; cAddr < params.flash_addr + params.flash_length; cAddr = cAddr + params.PAGE_SIZE){
        params.flash.erasePage(cAddr);
    }

    return this.prepare();
};

// Прочитать список файлов
FlashFS.prototype.list = function(){
    if (this.check()){
        let pos = params.flash_addr + params.HEADER_BYTE.length;
        let ls = [];

        // Если найдена позиция BOF файла
        while (params.flash.read(params.BOF_LENGTH, pos) == [params.BOF_BYTE]){
            let f = {};

            f.bof = pos;
            pos += params.BOF_LENGTH;

            // Имя файла
            f.path = E.toString(params.flash.read(params.FILE_NAME_LENGTH, pos)).trim();
            pos += params.FILE_NAME_LENGTH;

            // Размер файла
            f.length = this.b4u32(params.flash.read(params.FILE_SIZE_LENGTH, pos)); // note [0] is max 127
            pos += params.FILE_SIZE_LENGTH;

            // Адрес файла
            f.addr = this.b4u32(params.flash.read(params.FILE_ADDR_LENGTH, pos));
            pos += params.FILE_ADDR_LENGTH;

            // Проверка на EOF файла
            if (params.flash.read(params.EOF_LENGTH, pos) == [params.EOF_BYTE]){
                f.eof = pos;
                pos += params.EOF_LENGTH;

            } else {
                throw new Error("FS: file '" + f.path + "' hasn't EOF!");
            }

            // Добавляем файловый дескриптор в коллекцию
            ls.push(f);
        }

        return ls;

    } else {
        throw new Error("FS not created yet!");
    }
};

// Открыть файл
FlashFS.prototype.openFile = function(path, mode){
	let ls = this.list();
    let existsFile = ls.find((x) => x.path.toLowerCase() == path.toLowerCase());

	switch(mode){
		case "w":
			if (existsFile){
				throw new Error("FS: file '" + path + "' already exists! Try another name for write!");
            }

            if (path.length > params.FILE_NAME_LENGTH){
                throw new Error("FS: name must be maximum '" + params.FILE_NAME_LENGTH + "' chars!");
            }

            let newPath = path.padEnd(params.FILE_NAME_LENGTH, " ");
            let newBof, lastUsedAddr;

            // Адрес BOF для нового файла
            if (ls.length > 0){
                let lastFile = ls[ls.length - 1];
                newBof = lastFile.eof + params.EOF_LENGTH;
                lastUsedAddr = lastFile.addr;

            } else {
                newBof = params.flash_addr + params.HEADER_BYTE.length;
                lastUsedAddr = newBof;
            }

            // Проверка, не вышел ли новый файл за пределы таблицы дескрипторов
            let newEof = newBof + params.BOF_LENGTH + params.FILE_NAME_LENGTH + params.FILE_SIZE_LENGTH + params.FILE_ADDR_LENGTH + params.EOF_LENGTH;
            if (newEof - params.flash_addr > params.PAGE_SIZE - 1){
                throw new Error("FS has maximum files!");
            }

            // Адрес для начала записи тела файла
            newAddr = params.flash_addr + ((Math.floor((lastUsedAddr - params.flash_addr) / params.PAGE_SIZE) + 1) * params.PAGE_SIZE);

            if (newAddr >= params.flash_length){
                throw new Error("FS is full!");
            }

            // Запишем BOF, имя, адрес и EOF. Размер файла пропустим, будет заполнен при его закрытии
            params.flash.write(params.BOF_BYTE, newBof);
            params.flash.write(newPath, newBof + params.BOF_LENGTH);
            params.flash.write(this.u32b4(newAddr), newBof + params.BOF_LENGTH + params.FILE_NAME_LENGTH + params.FILE_SIZE_LENGTH);
            params.flash.write(params.EOF_BYTE, newBof + params.BOF_LENGTH + params.FILE_NAME_LENGTH + params.FILE_SIZE_LENGTH + params.FILE_ADDR_LENGTH);

            // Для выполнения записи требуется передать BOF файла и адрес
            let writeFile = {bof: newBof, addr: newAddr};
			return new FileFS(this, writeFile, mode);

		case "r":
            if (existsFile){
                return new FileFS(this, existsFile, mode);
            }

			throw new Error("FS: file '" + path + "' not exists!");

		default:
		    throw new Error("FS: mode '" + mode + "' is not allowed!");
	}
};

// Оболочка для работы с файлами
function FileFS(fs, fileIndex, mode){
    this.fs = fs;
    this.fileIndex = fileIndex;
    this.mode = mode;

    // Выставляем указатель на первый байт тела файла
    this.seekPos = fileIndex.addr;
}

// Выполняет неблокирующее чтение файла и запись порциями в объект destination
FileFS.prototype.pipe = function(destination, options){
    var chunkSize = options && options.chunkSize || 32;
    var buffer;

    while(buffer = this.read(chunkSize)){
        destination.write(buffer);
    };

    // После выполнения вызываем функцию завершения
    if (options && typeof options.complete === "function") {
        options.complete();
    }
};

// Передвигает текущую позицию чтения/записи на указанное количество байт вперед/назад
// Возвращает абсолютную позицию потока
FileFS.prototype.seek = function(nBytes){
    let newSeekPos = this.seekPos + (nBytes || 0);

    // Если передвигаем позицию за пределы начала файла или конца флеша
    if (newSeekPos < this.fileIndex.addr || newSeekPos > this.fs.addr){
        throw new Error("FS: Wrong position to seek!");
    }

    return this.seekPos = newSeekPos;
};

// Передвигает текущую позицию чтения/записи вперед на указанное количество байт
FileFS.prototype.skip = function(nBytes){
    nBytes = nBytes || 0;

    if (nBytes < 0){
        throw new Error("FS: nBytes should be positive number!");
    }

    this.seek(nBytes);
};

// Функция чтения возвращает строку. Указываем количество байт, которые требуется прочесть
FileFS.prototype.read = function(length){
    if (this.mode == "w"){
        throw new Error("FS: Can't read in write mode!");
    }

    let absEof = this.fileIndex.addr + this.fileIndex.length;
    let availableLength = absEof - (this.seekPos + length);

    // Если доступно меньше запрашиваемого размера, тогда отдаём всё что осталось
    if (availableLength > 0){
        availableLength = length;
    } else {
        availableLength = absEof - this.seekPos;
    }

    if (availableLength > 0){
        let buffer = params.flash.read(availableLength, this.seekPos);
        this.seekPos += availableLength;

        return E.toString(buffer);
    }

    return;
};

// Записываем данные в файл
// buffer - если строка, то запишется как массив байт. Если является целым числом, тогда пишется один байт
FileFS.prototype.write = function(buffer){
    let lenBuffer;

    if (typeof buffer === "object" || typeof buffer === "string"){
        lenBuffer = buffer.length;
    } else {
        lenBuffer = 1;
    }

    if (this.mode == "r"){
        throw new Error("FS: Can't write in read mode!");
    }

    if (this.seekPos + lenBuffer >= params.flash_length){
        throw new Error("FS: Can't write. Not enough free space!");
    }

    params.flash.write(buffer, this.seekPos);
    this.seekPos += lenBuffer;

    return lenBuffer;
};

// Обязательно закрываем файл в операциях записи
FileFS.prototype.close = function(){
    if (this.mode == "r"){
        return;
    }

    // Запишем размер файла
    let lenFile = this.seekPos - this.fileIndex.addr;
    params.flash.write(this.fs.u32b4(lenFile), this.fileIndex.bof + params.BOF_LENGTH + params.FILE_NAME_LENGTH);
};

exports = function(flashObject, start_addr, length){ return new FlashFS(flashObject, start_addr, length) };
 
/* ***********************************          ТЕСТЫ        ***********************************  */
/*
let flash = require("Flash");
let vfs = exports.init(flash, 1048576, 3125248);

try {
    vfs.list();
} catch (ex) {
    console.log("Check FS not init: " + ex.message);
}

vfs.prepare();

let f = vfs.openFile("ABC.txt", "w");
f.write("Hello World!");
f.write("12345")
f.write("!");
f.close();


try {
    vfs.openFile("NotExists.txt", "r");
} catch (ex) {
    console.log("Check File not exists: " + ex.message);
}

try {
    vfs.openFile("ABC.txt")    
} catch (ex) {
    console.log("Check file with unknown mode: " + ex.message);
}

let f2 = vfs.openFile("File2.txt", "w")
f2.write("success!!!")
f2.write("There are many variations of passages of Lorem Ipsum available, but the majority have suffered alteration in some form, by injected humour, or randomised words which don't look even slightly believable. If you are going to use a passage of Lorem Ipsum, you need to be sure there isn't anything embarrassing hidden in the middle of text. All the Lorem Ipsum generators on the Internet tend to repeat predefined chunks as necessary, making this the first true generator on the Internet. It uses a dictionary of over 200 Latin words, combined with a handful of model sentence structures, to generate Lorem Ipsum which looks reasonable. The generated Lorem Ipsum is therefore always free from repetition, injected humour, or non-characteristic words etc.@");
f2.close()

f2 = vfs.openFile("File2.txt", "r")
var buffer;

while (buffer = f2.read(10)){
    console.log(data);
}

*/
/*
vfs.list();
vfs.write("ABC.txt", "Hello World!");
vfs.list();

vfs.write("BigFile.txt", "A".repeat(2128));

    Example data                                        Size  Offset  Description

    56 46 53                                              3     0    FS Header, ASCII 'VFS'
    FA                                                    1     3    Start of each file (BOF)
      48 65 6C 6C 6F 57 6F 72 6C 64 2E 70 6E 67 00 00    16     4    FilePath has 16 bytes  'HelloWorld.png'
      00 00 00 0A                                         4    20    Filesize for content 'HelloWorld 12345', 16 bytes
      00 77 88 99                                         4    24    FileAddr from flash
    FB                                                    1    28    End of each file (EOF)

    VFS contains maximum 163 files, because content is being write with second page.
    Content of file writing in start of page. Note: file 4000 bytes has reserving 4096 bytes of page. File 4100 bytes has reserving 8192 bytes.

    File descriptor is object:

    { "bof": 100000,
      "path": "sample.txt",
      "length": 200,
      "addr": 100024,
      "eof": 100220  }

*/
