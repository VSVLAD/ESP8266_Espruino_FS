/* Copyright (c) 2022 Kruglov Vladilen aka VSVLAD. See the file LICENSE for copying permission. */
/*
    This is a module for project espruino that implements a very simple file system for ESP8266 boards.
    File access objects have a similar interface to the File object of the FS module.
    Write and read operations are supported. Delete operation not implemented yet
*/

/**
* Private constants
*/
let params = {
    PAGE_SIZE: 4096,

    FILE_NAME_LENGTH: 32,
    FILE_SIZE_LENGTH: 4,
    FILE_ADDR_LENGTH: 4,
    BOF_LENGTH: 1,
    EOF_LENGTH: 1,

    HEADER_BYTES: [0x46, 0x53],
    BOF_BYTE: 0xFA,
    EOF_BYTE: 0xFB,

    flash: undefined,
    flash_addr: undefined,
    flash_length: undefined
};

/**
* Constructor for initialize FS
* @constructor
* @param	{object} flashObject typicaly is object module "Flash"
* @param	{number} first address for reserving
* @param	{number} length of bytes for reserving
* @return	{object} wrapper object for working with FS
*/
function FlashFS(flashObject, start_addr, length){
    params.flash = flashObject;
    params.flash_addr = start_addr;
    params.flash_length = length;
}

/**
* Utility method for convert 4-bytes array into UInt32. Note: arr note[0] must have 127 maximum!
* @param  {string} array of bytes
* @return {number} representing UInt32
*/
FlashFS.prototype.b4u32 = function(arr){
    return (arr[3]) | (arr[2] << 8) | (arr[1] << 16) | (arr[0] << 24);
};

/**
* Utility method for convert UInt32 number into 4-bytes array
* @param  {string} source number
* @return {number} return bytes array
*/
FlashFS.prototype.u32b4 = function(number){
    return [(number >> 24) & 0xFF, (number >> 16) & 0xFF, (number >> 8)  & 0xFF, (number >> 0)  & 0xFF];
};

/**
* Method for checking file system for working
* @return {boolean} true if file system is prepared
*/
FlashFS.prototype.check = function(){
    if (params.flash.read(params.HEADER_BYTES.length, params.flash_addr) != params.HEADER_BYTES){
        return false;
    }

    return true;
};

/**
* Method for initialization file system. While we writing only header and check it
* @return {boolean} true if file system is prepared
*/
FlashFS.prototype.prepare = function(){
    params.flash.write(params.HEADER_BYTES, params.flash_addr);
    return this.check();
};


/**
* Format is full erasing flash pages (all bytes set 255) and call prepare method for initialize FS
* @return {boolean} true if file system is prepared
*/
FlashFS.prototype.format = function(){

    // NOTE: need rewrite for chunk operations. WDT maybe cause problem
    for (let cAddr = params.flash_addr; cAddr < params.flash_addr + params.flash_length; cAddr = cAddr + params.PAGE_SIZE){
        params.flash.erasePage(cAddr);
    }

    return this.prepare();
};

/**
* Check path exists
* @param  {string} path to file
* @return {number} return true or false
*/
FlashFS.prototype.exists = function(path){
    let existsFile = this.list().find((x) => x.path.toLowerCase() == path.toLowerCase());
    return existsFile != undefined;
};

/**
* Return array of all file names from FS. Each file object has advanced properties for file operations.
* @param  {boolean} if true return full index object used for file operations
* @return {object} array of file object. File descriptor has BOF, EOF - special bytes for segmenting files in FS table. ADDR - first byte of file content, LENGTH - file size.
*/
FlashFS.prototype.list = function(full){
    if (this.check()){
        let pos = params.HEADER_BYTES.length;
        let ls = [];

        // Если найдена позиция BOF файла
        while (params.flash.read(params.BOF_LENGTH, params.flash_addr + pos) == [params.BOF_BYTE]){
            let f = {};

            if (full) { f.bof = pos; }
            pos += params.BOF_LENGTH;

            // Имя файла
            f.path = E.toString(params.flash.read(params.FILE_NAME_LENGTH, params.flash_addr + pos)).trim();
            pos += params.FILE_NAME_LENGTH;

            // Размер файла
            f.length = this.b4u32(params.flash.read(params.FILE_SIZE_LENGTH, params.flash_addr + pos)); // note [0] is max 127
            pos += params.FILE_SIZE_LENGTH;

            // Адрес файла
            if (full) { f.addr = this.b4u32(params.flash.read(params.FILE_ADDR_LENGTH, params.flash_addr + pos)); }
            pos += params.FILE_ADDR_LENGTH;

            // Проверка на EOF файла
            if (params.flash.read(params.EOF_LENGTH, params.flash_addr + pos) == [params.EOF_BYTE]){
                if (full) { f.eof = pos; }
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

/**
* Primary method for opening file for write and read operations
* @param  {string} path that has 16 maximum chars
* @param  {string} mode "r" for reading or "w" for writing operation
* @return {number} FileFS object to manage read and write position
*/
FlashFS.prototype.openFile = function(path, mode){
	let ls = this.list(true);
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
                lastUsedAddr = lastFile.addr + lastFile.length - 1;

            } else {
                newBof = params.HEADER_BYTES.length;
                lastUsedAddr = params.PAGE_SIZE - 1;
            }

            // Проверка, не вышел ли новый файл за пределы таблицы дескрипторов
            let newEof = newBof + params.BOF_LENGTH + params.FILE_NAME_LENGTH + params.FILE_SIZE_LENGTH + params.FILE_ADDR_LENGTH + params.EOF_LENGTH;
            if (newEof > params.PAGE_SIZE - 1){
                throw new Error("FS has maximum files!");
            }

            // Адрес для начала записи тела файла
            let newAddr = lastUsedAddr + 1;
            if (newAddr >= params.flash_length){
                throw new Error("FS is full!");
            }

            // Запишем BOF, имя, адрес и EOF. 
            params.flash.write(params.BOF_BYTE, params.flash_addr + newBof);
            params.flash.write(newPath, params.flash_addr + newBof + params.BOF_LENGTH);
            // >>> params.flash.write(...) <<< Размер файла пропустим, будет заполнен при его закрытии
            params.flash.write(this.u32b4(newAddr), params.flash_addr + newBof + params.BOF_LENGTH + params.FILE_NAME_LENGTH + params.FILE_SIZE_LENGTH);
            params.flash.write(params.EOF_BYTE, params.flash_addr + newBof + params.BOF_LENGTH + params.FILE_NAME_LENGTH + params.FILE_SIZE_LENGTH + params.FILE_ADDR_LENGTH);

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

/**
* Object for file operation: read, write, seek and other. It instanced internally in openFile method and user don't need do it self
* @constructor
* @param  {object} object of FS. FileFS working with flash module and use ref of FS object for manipulating (write/read/seek)
* @param  {object} file descriptor of list method
* @param  {string} mode "r" or "w"
* @return {object} object wrapper with file operations methods
*/
function FileFS(fs, fileIndex, mode){
    this.fs = fs;
    this.fileIndex = fileIndex;
    this.mode = mode;

    // Выставляем указатель на первый байт тела файла
    this.seekAddr = 0;
}

/**
* Pipe implements a method for non-blocking reading of a file and writing to a destination object
* @param  {object} destination is object, which has write method
* @return {object} options is optional object. Default chunkSize is 32. See sources for more information
*/
FileFS.prototype.pipe = function(destination, options){
    let chunkSize = options && options.chunkSize || 32;
    let buffer;
    let pipeId;

    function pipeRead(){
        if (buffer = this.read(chunkSize)) {
            destination.write(buffer);
            buffer = null;
        } else {

            // Выключаем таймер
            clearInterval(pipeId);

            // Если требуется, вызываем функцию завершения
            if (options && options.end == true) {
                destination.end();
            }
    
            // Если требуется, вызываем функцию успеха
            if (options && typeof options.complete === "function") {
                options.complete();
            }
        }
    }
    
    // Планируем таймер
    pipeId = setInterval(pipeRead.bind(this));
};

/**
* Seek method change stream cursor position in file. Work in read mode only. If nBytes is not set then returning current position in all modes
* @param  {number} nBytesPos is new position. 0 - start of file body, max value - length of file
* @return {string} Returns the position
*/
FileFS.prototype.seek = function(nBytesPos){
    if (nBytesPos != undefined){
        if (this.mode == "w"){
            throw new Error("FS: Can't seek in write mode!");
        }

        if (nBytesPos < 0){
            throw new Error("FS: Seek value should be positive number!");
        }

        // Если передвигаем позицию за пределы начала файла или конца флеша
        if (nBytesPos > this.fileIndex.length){
            throw new Error("FS: Wrong position to seek!");
        }
        this.seekAddr = nBytesPos;
    }

    // Возвращаем относительную позицию
    return this.seekAddr;
};

/**
* Skip bytes forward after current position. Work in write mode only.
* @param  {number} nBytes is count bytes for skipping.
* @return {string} Returns the new position
*/
FileFS.prototype.skip = function(nBytes){
    if (nBytes){
        if (this.mode == "r"){
            throw new Error("FS: Can't skip in read mode!");
        }

        if (nBytes < 0){
            throw new Error("FS: Skip value should be positive number!");
        }

        let newSkipAddr = this.seekAddr + nBytes;
        if (this.fileIndex.addr + newSkipAddr > params.flash_length){
            throw new Error("FS: Skip position can't be less than begin of file or over flash length!");
        }

        this.seekAddr = newSkipAddr;
    }

    // Возвращаем относитетельную позицию
    return this.seekAddr;
};

/**
* Read file content and return string. Only "r" mode for using. More information in readBytes method
* @param  {number} length is count of bytes for reading
* @return {string} Read bytes are converted to a string
*/
FileFS.prototype.read = function(length){
    let buffer = this.readBytes(length);
    
    if (buffer) {
        return E.toString(buffer);
    } else {
        return;
    }
};

/**
* Read file content and return UInt8 array. Only "r" mode for using
* @param  {number} length is count of bytes for reading.
* If the file is longer than its size, or the read position does not allow the specified number of bytes to be read, the available number will be read.
* Return undefined if reading position equal end of file
* @return {object} array of reading bytes
*/
FileFS.prototype.readBytes = function(length){
    if (this.mode == "w"){
        throw new Error("FS: Can't read in write mode!");
    }

    let availableLength = this.fileIndex.length - (this.seekAddr + length);

    // Если доступно меньше запрашиваемого размера, тогда отдаём всё что осталось
    if (availableLength > 0){
        availableLength = length;
    } else {
        availableLength = this.fileIndex.length - this.seekAddr;
    }

    // Читаем по абсолютному пути: смещение на флеш + адрес файла + позиция
    if (availableLength > 0){
        let buffer = params.flash.read(availableLength, params.flash_addr + this.fileIndex.addr + this.seekAddr);
        this.seekAddr += availableLength;

        return buffer;
    }

    return;
};

/**
* Write file content in current position. Only "w" mode for using
* @param  {string} object, array, string or number. If is number, then it see as byte and value up to 255
* @return {number} number of writing bytes
*/
FileFS.prototype.write = function(buffer){
    if (this.mode == "r"){
        throw new Error("FS: Can't write in read mode!");
    }

    let lenBuffer;

    if (typeof buffer === "object" || typeof buffer === "string"){
        lenBuffer = buffer.length;
    } else {
        lenBuffer = 1;
    }

    if (this.fileIndex.addr + this.seekAddr + lenBuffer > params.flash_length){
        throw new Error("FS: Can't write. Not enough free space!");
    }

    // Пишем по абсолютному пути: смещение на флеш + адрес файла + позиция
    params.flash.write(buffer, params.flash_addr + this.fileIndex.addr + this.seekAddr);
    this.seekAddr += lenBuffer;

    return lenBuffer;
};

/**
* The close method must be called on write operations! When used method, function calculate real file size and write in FS table
* @return {undefined} always return true 
*/
FileFS.prototype.close = function(){
    if (this.mode == "w"){
        
        // Запишем размер файла
        let lenFile = this.seekAddr - this.fileIndex.addr;
        params.flash.write(this.fs.u32b4(lenFile), params.flash_addr + this.fileIndex.bof + params.BOF_LENGTH + params.FILE_NAME_LENGTH);
    }

    return true;
};

exports = function(flashObject, start_addr, length){ return new FlashFS(flashObject, start_addr, length) };
