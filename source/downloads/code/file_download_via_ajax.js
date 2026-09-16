$('#GetFile').on('click', function () {
    $.ajax({
        url: 'https://blog.kurl.cc/static/P60524-122812.jpg',
        xhr: function () {
            var xhr = $.ajaxSettings.xhr();
            xhr.onprogress = function (e) {
                // For downloads
                if (e.lengthComputable) {
                    console.log(e.loaded / e.total);
                }
            };
            xhr.upload.onprogress = function (e) {
                // For uploads
                if (e.lengthComputable) {
                    console.log(e.loaded / e.total);
                }
            };
            return xhr;
        },
        method: 'GET',
        xhrFields: {
            responseType: 'blob'
        },
        success: function (data) {
            var a = document.createElement('a');
            var url = window.URL.createObjectURL(data);
            a.href = url;
            a.download = 'P60524.jpg';
            a.click();
            window.URL.revokeObjectURL(url);
        }
    });
});