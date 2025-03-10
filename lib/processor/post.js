/**
 * mirror from https://github.com/hexojs/hexo/blob/4.2.1/lib/plugins/processor/post.js
 * 
 * - add line `categories = autoClassify(config, data, categories);`
 * 
 * - remove hexo-util `Pattern`,
 *   because hexo-util version may not match hexo/node_modules/hexo-util,
 *   and will cause a error within `new Pattern(new Pattern())`
 */
'use strict';

const { toDate, timezone, isExcludedFile, isTmpFile, isHiddenFile, isMatch } = require('./common');
const Promise = require('bluebird');
const yfm = require('hexo-front-matter');
const { extname, join, basename } = require('path');
const { stat, listDir } = require('hexo-fs');
const { slugize, Permalink } = require('hexo-util');
const autoClassify = require('../classify');

const postDir = '_posts/';
const draftDir = '_drafts/';
let permalink;

const preservedKeys = {
  title: true,
  year: true,
  month: true,
  day: true,
  i_month: true,
  i_day: true,
  hash: true
};

module.exports = ctx => {
  function processPost(file) {
    const Post = ctx.model('Post');
    const { path } = file.params;
    const doc = Post.findOne({source: file.path});
    const { config } = ctx;
    const { timezone: timezoneCfg } = config;
    // Deprecated: use_date_for_updated will be removed in future
    const updated_option = config.use_date_for_updated === true ? 'date' : config.updated_option;
    let categories, tags;

    if (file.type === 'skip' && doc) {
      return;
    }

    if (file.type === 'delete') {
      if (doc) {
        return doc.remove();
      }

      return;
    }

    return Promise.all([
      file.stat(),
      file.read()
    ]).spread((stats, content) => {
      const data = yfm(content);
      const info = parseFilename(config.new_post_name, path);
      const keys = Object.keys(info);

      data.source = file.path;
      data.raw = content;
      data.slug = info.title;

      if (file.params.published) {
        if (!Object.prototype.hasOwnProperty.call(data, 'published')) data.published = true;
      } else {
        data.published = false;
      }

      for (let i = 0, len = keys.length; i < len; i++) {
        const key = keys[i];
        if (!preservedKeys[key]) data[key] = info[key];
      }

      if (data.date) {
        data.date = toDate(data.date);
      } else if (info && info.year && (info.month || info.i_month) && (info.day || info.i_day)) {
        data.date = new Date(
          info.year,
          parseInt(info.month || info.i_month, 10) - 1,
          parseInt(info.day || info.i_day, 10)
        );
      }

      if (data.date) {
        if (timezoneCfg) data.date = timezone(data.date, timezoneCfg);
      } else {
        data.date = stats.birthtime;
      }

      data.updated = toDate(data.updated);

      if (data.updated) {
        if (timezoneCfg) data.updated = timezone(data.updated, timezoneCfg);
      } else if (updated_option === 'date') {
        data.updated = data.date;
      } else if (updated_option === 'empty') {
        delete data.updated;
      } else {
        data.updated = stats.mtime;
      }

      if (data.category && !data.categories) {
        data.categories = data.category;
        delete data.category;
      }

      if (data.tag && !data.tags) {
        data.tags = data.tag;
        delete data.tag;
      }

      categories = data.categories || [];
      tags = data.tags || [];

      if (!Array.isArray(categories)) categories = [categories];
      if (!Array.isArray(tags)) tags = [tags];

      categories = autoClassify(config, data, categories);

      if (data.photo && !data.photos) {
        data.photos = data.photo;
        delete data.photo;
      }

      if (data.photos && !Array.isArray(data.photos)) {
        data.photos = [data.photos];
      }

      if (data.link && !data.title) {
        data.title = data.link.replace(/^https?:\/\/|\/$/g, '');
      }

      if (data.permalink) {
        data.__permalink = data.permalink;
        delete data.permalink;
      }

      // FIXME: Data may be inserted when reading files. Load it again to prevent
      // race condition. We have to solve this in warehouse.
      const doc = Post.findOne({source: file.path});

      let filename = basename(file.path, extname(file.path))
      if (!data.title) {
        data.title = filename
      }
      if (doc) {
        return doc.replace(data);
      }

      return Post.insert(data);
    }).then(doc => Promise.all([
      doc.setCategories(categories),
      doc.setTags(tags),
      scanAssetDir(doc)
    ]));
  }

  function scanAssetDir(post) {
    if (!ctx.config.post_asset_folder) return;

    const assetDir = post.asset_dir;
    const baseDir = ctx.base_dir;
    const baseDirLength = baseDir.length;
    const PostAsset = ctx.model('PostAsset');

    return stat(assetDir).then(stats => {
      if (!stats.isDirectory()) return [];

      return listDir(assetDir);
    }).catch(err => {
      if (err && err.code === 'ENOENT') return [];
      throw err;
    }).filter(item => !isExcludedFile(item, ctx.config)).map(item => {
      const id = join(assetDir, item).substring(baseDirLength).replace(/\\/g, '/');
      const asset = PostAsset.findById(id);

      if (asset) return post.published === false ? asset.remove() : undefined; // delete if already exist
      else if (post.published === false) return undefined; // skip assets for unpulished posts and

      return PostAsset.save({
        _id: id,
        post: post._id,
        slug: item,
        modified: true
      });
    });
  }

  function processAsset(file) {
    const PostAsset = ctx.model('PostAsset');
    const Post = ctx.model('Post');
    const id = file.source.substring(ctx.base_dir.length).replace(/\\/g, '/');
    const doc = PostAsset.findById(id);

    if (file.type === 'delete') {
      if (doc) {
        return doc.remove();
      }

      return;
    }

    // TODO: Better post searching
    const post = Post.toArray().find(post => file.source.startsWith(post.asset_dir));

    if (post != null && post.published) {
      return PostAsset.save({
        _id: id,
        slug: file.source.substring(post.asset_dir.length),
        post: post._id,
        modified: file.type !== 'skip',
        renderable: file.params.renderable
      });
    }

    if (doc) {
      return doc.remove();
    }
  }

  return {
    pattern: path => {
      if (isTmpFile(path)) return;

      let result;

      if (path.startsWith(postDir)) {
        result = {
          published: true,
          path: path.substring(postDir.length)
        };
      } else if (path.startsWith(draftDir)) {
        result = {
          published: false,
          path: path.substring(draftDir.length)
        };
      }

      if (!result || isHiddenFile(result.path)) return;

      result.renderable = ctx.render.isRenderable(path) && !isMatch(path, ctx.config.skip_render);
      return result;
    },

    process: function postProcessor(file) {
      if (file.params.renderable) {
        return processPost(file);
      } else if (ctx.config.post_asset_folder) {
        return processAsset(file);
      }
    }
  };
};

function parseFilename(config, path) {
  config = config.substring(0, config.length - extname(config).length);
  path = path.substring(0, path.length - extname(path).length);

  if (!permalink || permalink.rule !== config) {
    permalink = new Permalink(config, {
      segments: {
        year: /(\d{4})/,
        month: /(\d{2})/,
        day: /(\d{2})/,
        i_month: /(\d{1,2})/,
        i_day: /(\d{1,2})/,
        hash: /([0-9a-f]{12})/
      }
    });
  }

  const data = permalink.parse(path);

  if (data) {
    return data;
  }

  return {
    title: slugize(path)
  };
}
