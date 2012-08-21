var httpsys = require(process.env.HTTPSYS_NATIVE || './httpsys.node')
    , events = require('events')
    , util = require('util');

// Currently active HTTP[S] servers (Server instances), keyed by HTTP.SYS's request queue ID
var servers = {};

// This is a v-table mapping event types defined by uv_httpsys_event_type in httpsys.h
// to action methods. This is used in Server.prototype._dispatch.
// Order is important and must match uv_httpsys_event_type.
var nativeEvents = [
    undefined,                        // 0 - unused
    '_on_error_initializing_request', // 1
    '_on_error_new_request',          // 2
    '_on_new_request',                // ...
    '_on_error_initializing_read_request_body',
    '_on_end_request',
    '_on_error_read_request_body',
    '_on_request_body',
    '_on_headers_written',
    '_on_error_writing_headers',
    '_on_body_written',
    '_on_error_writing_body'
];

// Maps known HTTP response header name to HTTP_HEADER_ID enum value
// http://msdn.microsoft.com/en-us/library/windows/desktop/aa364526(v=vs.85).aspx
var knownResponseHeaders = {
    'cache-control': 0,
    'connection': 1,
    'date': 2,
    'keep-alive': 3,
    'pragma': 4,
    'trailer': 5,
    'transfer-encoding': 6,
    'upgrade': 7,
    'via': 8,
    'warning': 9,
    'alive': 10,
    'content-length': 11,
    'content-type': 12,
    'content-encoding': 13,
    'content-language': 14,
    'content-location': 15,
    'content-md5': 16,
    'content-range': 17,
    'expires': 18,
    'last-modified': 19,
    'accept-ranges': 20,
    'age': 21,
    'etag': 22,
    'location': 23,
    'proxy-authenticate': 24,
    'retry-after': 25,
    'server': 26,
    'set-cookie': 27,
    'vary': 28,
    'www-authenticate': 29,
    'if-modified-since': 30,
    'if-none-match': 31,
    'if-range': 32,
    'if-unmodified-since': 33,
    'max-forwards': 34,
    'proxy-authorization': 35,
    'referer': 36,
    'range': 37,
    'te': 38,
    'translate': 39,
    'user-agent': 40
};

// Constants for chunked transfer encoding.
var lastChunk = new Buffer('0\x0d\x0a\x0d\x0a');
var crlf = new Buffer('\x0d\x0a');

httpsys.httpsys_init({
    initialBufferSize: process.env.HTTPSYS_BUFFER_SIZE || 4096,
    callback: function (args) {
        var server = servers[args.requestQueue];
        if (server)
            return server._dispatch(args);
        else
            throw new Error('Server associated with HTTP.SYS request queue ' 
                + args.requestQueue + ' does not exist.');
    }
});

function ServerRequest(args, requestContext) {
    events.EventEmitter.call(this);
    this._requestContext = requestContext;
    for (var i in args.req) {
        this[i] = args.req[i];
    }

    this.httpVersion = this.httpVersionMajor + '.' + this.httpVersionMinor;
    this._encoding = 'binary';
};

util.inherits(ServerRequest, events.EventEmitter);

ServerRequest.prototype.pause = function () {
    this._paused = true;
};

ServerRequest.prototype.resume = function () {
    if (this._paused) {
        if (!this._requestContext.asyncPending && !this._requestContext.requestRead) {
            httpsys.httpsys_resume(this._requestContext);
        }

        delete this._paused;
    }
};

ServerRequest.prototype.setEncoding = function (encoding) {
    this._encoding = encoding || 'utf8';
};

ServerRequest.prototype._on_request_body = function (args) {
    if (this._encoding === 'binary') {
        this.emit('data', args.data);
    }
    else {
        this.emit('data', args.data.toString(this._encoding));
    }
};

ServerRequest.prototype._on_end_request = function () {
    this._requestContext.requestRead = true;
    this.emit('end');

    // Signal the response to start sending cached response content if any
    // had been accumulated while the response was being received.

    this._requestContext.res._initiate_send_next();
};

function ServerResponse(requestContext) {
    events.EventEmitter.call(this);
    this._requestContext = requestContext;
    this.sendDate = true;
};

util.inherits(ServerResponse, events.EventEmitter);

ServerResponse.prototype.writeHead = function (statusCode, reasonPhrase, headers) {
    if (!statusCode || isNaN(+statusCode))
        throw new Error('Status code must be specified as a positive integer.');

    if (typeof reasonPhrase === 'object') {
        headers = reasonPhrase;
        reasonPhrase = '';
    }
    else if (reasonPhrase === null || typeof reasonPhrase === 'undefined') {
        reasonPhrase = '';
    }
    else if (typeof reasonPhrase !== 'string') 
        throw new Error('Reason phrase must be a string.');

    if (typeof headers !== 'undefined' && typeof headers !== 'object') 
        throw new Error('Headers must be an object.');

    if (this._requestContext.headersWritten) 
        throw new Error('The writeHead method cannot be called after the response headers have been sent.');

    this._requestContext.statusCode = statusCode;
    this._requestContext.reason = reasonPhrase;
    if (headers) {
        for (var i in headers)
            this._requestContext.headers[i.toLowerCase()] = headers[i].toString();
    }
}

ServerResponse.prototype.write = function(chunk, encoding, isEnd) {
    if (!this._requestContext.headers)
        throw new Error('The writeHead method must be called before the write method.');

    if (!this._requestContext.knownHeaders) {

        // First call to write prepares the cached response headers

        // Process headers into known and unknown to HTTP.SYS.

        this._requestContext.knownHeaders = [];
        this._requestContext.unknownHeaders = {};
        for (var i in this._requestContext.headers) {
            var id = knownResponseHeaders[i];
            if (id === undefined)
                this._requestContext.unknownHeaders[il] = this._requestContext.headers[i];
            else
                this._requestContext.knownHeaders[id] = this._requestContext.headers[i];
        }

        // Determine if chunked transfer encoding must be applied.

        if (!this._requestContext.knownHeaders[11] && !this._requestContext.knownHeaders[6]) {
            // Neither Content-Length or Transfer-Encoding headers were specified.
            // Apply chunked transfer encoding around response body chunks.

            this._requestContext.chunkResponse = true;
            this._requestContext.knownHeaders[6] = 'chunked';
        }
    }

    // Queue up the chunk of the body to be sent after headers have been sent.
    this._queue_body_chunk(chunk, encoding, isEnd);

    return this._initiate_send_next();
}

ServerResponse.prototype.end = function (chunk, encoding) {
    return this.write(chunk, encoding, true);
}

ServerResponse.prototype.writeContinue = function () {
    throw new Error('The writeContinue method is not supported because 100 Continue '
        + ' responses are sent automatically by HTTP.SYS.');
}

ServerResponse.prototype.setHeader = function (name, value) {
    if (typeof name !== 'string')
        throw new Error('The name parameter must be a string HTTP header name.');

    if (!value || Array.isArray(value)) 
        throw new Error('The value paramater must be a string HTTP header value.');

    // TODO: support for multiple headers with the same name

    if (this._requestContext.knownHeaders)
        throw new Error('Response headers cannot be modified after they have been sent to the client.');

    this._requestContext.headers[name.toLowerCase()] = value.toString();
}

ServerResponse.prototype.getHeader = function (name) {
    if (typeof name !== 'string')
        throw new Error('The name parameter must be a string HTTP header name.');

    if (this._requestContext.knownHeaders)
        throw new Error('Response headers cannot be accessed after they have been sent to the client.');

    return this._requestContext.headers[name.toLowerCase()];    
}

ServerResponse.prototype.removeHeader = function (name) {
    if (typeof name !== 'string')
        throw new Error('The name parameter must be a string HTTP header name.');

    if (this._requestContext.knownHeaders)
        throw new Error('Response headers cannot be modified after they have been sent to the client.');

    return delete this._requestContext.headers[name.toLowerCase()];    
}

ServerResponse.prototype.addTrailers = function () {
    // TODO support for trailers
    throw new Error('Support for trailers is not yet implemented.');
}

ServerResponse.prototype._queue_body_chunk = function (chunk, encoding, isEnd)
{
    if (this._requestContext.isLastChunk)
        throw new Error('No more response data can be written after the end method had been called.');

    if (!Buffer.isBuffer(chunk)) {
        if (typeof chunk === 'string') {
            chunk = new Buffer(chunk, encoding || 'utf8');
        }
        else if (chunk === null && isEnd !== true) {
            throw new Error('Chunk must be a string or a Buffer.');
        }
    }

    if (!this._requestContext.chunks)
        this._requestContext.chunks = [];

    if (chunk) {
        if (this._requestContext.chunkResponse)
            this._requestContext.chunks.push(
                new Buffer(chunk.length.toString(16) + '\x0d\x0a'),
                chunk,
                crlf);
        else
            this._requestContext.chunks.push(chunk);
    }

    if (isEnd) {
        this._requestContext.isLastChunk = true;
        if (this._requestContext.chunkResponse)
            this._requestContext.chunks.push(lastChunk);
    }
}

ServerResponse.prototype._on_headers_written = function () {
    this._initiate_send_next();
}

ServerResponse.prototype._on_body_written = function () {
    if (this._requestContext.drainEventPending && !this._requestContext.chunks) {
        delete this._requestContext.drainEventPending;
        this.emit('drain');
    }

    if (this._requestContext.chunks)
        this._initiate_send_next();
}

ServerResponse.prototype._initiate_send_next = function () {
    if (this._requestContext.asyncPending || !this._requestContext.requestRead) {
        // Another async operation is pending or the request has not been fully read yet.
        // Postpone send until entire request had been read and no async operations are pending. 

        if (this._requestContext.chunks) {
            // There is a chunk of the body to be sent, but it cannot be sent synchronously.
            // The 'drain' event must therefore be emitted once the chunk is sent in the future. 

            this._requestContext.drainEventPending = true;
        }

        return false;
    }

    if (this._requestContext.knownHeaders && !this._requestContext.headersWritten) {
        // Initiate sending HTTP response headers. 

        this._requestContext.headersWritten = true;

        // Since the first write of the body is what triggers
        // sending the cached response headers, the body chunk will not be written out 
        // synchronously. The 'drain' event must therefore be emitted once the chunk is sent in the future. 
        this._requestContext.drainEventPending = true;

        this._requestContext.asyncPending = true;
        httpsys.httpsys_write_headers(this._requestContext);

        return false;
    }
    else if (this._requestContext.chunks) {
        // Initiate sending HTTP response body.

        this._requestContext.asyncPending = true;
        httpsys.httpsys_write_body(this._requestContext);
        delete this._requestContext.chunks;

        return true;
    }

    return false;
}

function Server() {
    events.EventEmitter.call(this);
    this._activeRequests = {};
}

util.inherits(Server, events.EventEmitter);

Server.prototype.listen = function (port, hostname, callback) {
    if (this._server) 
        throw new Error('The server is already listening. Call close before calling listen again.');

    if (!port || isNaN(+port))
        throw new Error('Port must be specified as a positive integer.');

    if (typeof hostname === 'function') {
        callback = hostname;
        hostname = '127.0.0.1';
    }
    else if (typeof hostname === 'undefined') {
        hostname = '127.0.0.1';
    }

    if (typeof callback === 'function') {
        this.on('listening', callback);
    }

    var options = {
        url: this._scheme + hostname + ':' + port + '/',
        pendingReadCount: process.env.on_PENDING_READ_COUNT || 1
    };

    try {
        this._nativeServer = httpsys.httpsys_listen(options);
        servers[this._nativeServer.requestQueue] = this;
    }
    catch (e) {
        throw new Error('Error initializing the HTTP.SYS server. System error ' + e + '.');
    }

    this.emit('listening');
};

Server.prototype.close = function () {
    if (this._server) {
        try {
            httpsys.httpsys_stop_listen(this._nativeServer);
        }
        catch (e) {
            throw new Error('Error closing the HTTP.SYS listener. System error ' + e + '.');
        }

        delete servers[this._nativeServer.requestQueue];
        delete this._nativeServer;
        this.emit('close');
    }
};

Server.prototype._dispatch = function (args) {
    if (!args.eventType || !nativeEvents[args.eventType])
        throw new Error('Unrecognized eventType: ' + args.eventType);

    return this[nativeEvents[args.eventType]](args);
};

Server.prototype._getRequestContext = function(args) {
    var requestContext = this._activeRequests[args.uv_httpsys];
    if (!requestContext) {
        throw new Error('JavaScript ServerRequest matching uv_httpsys handle ' 
            + args.uv_httpsys + ' not found.');
    }

    return requestContext;
};

Server.prototype._on_error_initializing_request = function(args) {
    // This is a non-recoverable exception. Ignoring this exception would lead to 
    // the server becoming unresponsive due to lack of pending reads. 

    throw new Error('Unable to initiate a new asynchronous receive of an HTTP request against HTTP.SYS. '
        + 'System error ' + args.code + '.');
};

Server.prototype._on_error_new_request = function(args) {
    // The HTTP.SYS operation that was to receive a new HTTP request had failed. This
    // condition is safe to ignore - no JavaScript representation of the request exists yet, 
    // and the failed pending read had already been replaced with a new pending read. 

    this.emit('clientError', new Error('HTTP.SYS receive of a new HTTP request has failed. '
        + 'System errror ' + args.code + '.'));
};

Server.prototype._on_new_request = function(args) {
    var requestContext = {
        uv_httpsys: args.uv_httpsys,
        requestQueue: args.requestQueue,
        asyncPending: false,
        requestRead: false,
        server: this,
        headers: {}
    };

    requestContext.req = new ServerRequest(args, requestContext);
    requestContext.res = new ServerResponse(requestContext);
    this._activeRequests[args.uv_httpsys] = requestContext;

    this.emit('request', requestContext.req, requestContext.res);

    requestContext.asyncPending = !requestContext.req._paused;

    return requestContext.asyncPending;
};

Server.prototype._notify_error_and_dispose = function (args, target, message) {
    var requestContext = this._getRequestContext(args);
    requestContext.asyncPending = false;
    delete this._activeRequests[requestContext.uv_httpsys];
    requestContext.uv_httpsys = 0;
    requestContext[target].emit('error', new Error(message + ' System error ' + args.code + '.'));
};

Server.prototype._on_error_initializing_read_request_body = function(args) {
    // The headers of the HTTP request had already been read but initializing reading of the 
    // request body failed. Notify application code and clean up managed resources
    // representing the request. Native resources had already been released at this point.

    this._notify_error_and_dispose(args, 'req', 'Error initializing the reading of the request body.');
};

Server.prototype._on_end_request = function(args) {
    var requestContext = this._getRequestContext(args);
    requestContext.asyncPending = false;
    requestContext.req._on_end_request();
};

Server.prototype._on_error_read_request_body = function(args) {
    // The headers of the HTTP request had already been read but reading of the 
    // request body failed. Notify application code and clean up managed resources
    // representing the request. Native resources had already been released at this point.

    this._notify_error_and_dispose(args, 'req', 'Error reading the request body.');
};

Server.prototype._on_request_body = function(args) {
    var requestContext = this._getRequestContext(args);
    requestContext.asyncPending = false;
    requestContext.req._on_request_body(args);
    requestContext.asyncPending = !requestContext.req._paused;

    return requestContext.asyncPending;
};

Server.prototype._on_headers_written = function(args) {
    var requestContext = this._getRequestContext(args);
    requestContext.asyncPending = false;
    requestContext.res._on_headers_written();
};

Server.prototype._on_error_writing_headers = function(args) {
    // The HTTP request had already been fully read but sending of the 
    // response headers failed. Notify application code and clean up managed resources
    // representing the request. Native resources had already been released at this point.

    this._notify_error_and_dispose(args, 'res', 'Error sending response headers.');
};

Server.prototype._on_body_written = function(args) {
    var requestContext = this._getRequestContext(args);
    requestContext.asyncPending = false;
    if (requestContext.isLastChunk) {
        // HTTP request/response finished. Native resources have been already cleaned up.
        // Unregister the managed object.

        delete this._activeRequests[requestContext.uv_httpsys];
    }

    requestContext.res._on_body_written();
};

Server.prototype._on_error_writing_body = function(args) {
    // The HTTP request had already been fully read and response headers sent but sending of the 
    // response body failed. Notify application code and clean up managed resources
    // representing the request. Native resources had already been released at this point.

    this._notify_error_and_dispose(args, 'res', 'Error sending response body.');
};

function HttpServer() {
    Server.call(this);
    this._scheme = 'http://';
};

util.inherits(HttpServer, Server);

exports.http = {};
exports.http.Server = HttpServer;
exports.http.ServerRequest = ServerRequest;
exports.http.ServerResponse = ServerResponse;

exports.http.createServer = function (requestListener) {
    var server = new HttpServer();
    if (requestListener) {
        server.on('request', requestListener)
    }

    return server;
};